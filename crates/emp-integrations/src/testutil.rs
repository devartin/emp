//! Minimal scripted HTTP/1.1 server for tests (no network access needed).

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::Arc;

use parking_lot::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// A scripted response.
#[derive(Clone, Debug)]
pub(crate) struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    chunked: bool,
}

impl Reply {
    pub(crate) fn new(status: u16, content_type: &str, body: impl Into<Vec<u8>>) -> Self {
        Reply {
            status,
            headers: vec![("content-type".into(), content_type.into())],
            body: body.into(),
            chunked: false,
        }
    }

    pub(crate) fn json(status: u16, body: &str) -> Self {
        Reply::new(status, "application/json; charset=utf-8", body)
    }

    pub(crate) fn redirect(status: u16, location: &str) -> Self {
        Reply {
            status,
            headers: vec![("location".into(), location.into())],
            body: Vec::new(),
            chunked: false,
        }
    }

    pub(crate) fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    pub(crate) fn chunked(mut self) -> Self {
        self.chunked = true;
        self
    }
}

/// A request the server received.
#[derive(Clone, Debug)]
pub(crate) struct Recorded {
    pub(crate) method: String,
    pub(crate) path: String,
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) body: Vec<u8>,
}

impl Recorded {
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    pub(crate) fn body_str(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// Serves `replies` in order (one per connection, `Connection: close`); 500 when exhausted.
pub(crate) struct TestServer {
    addr: SocketAddr,
    recorded: Arc<Mutex<Vec<Recorded>>>,
    task: tokio::task::JoinHandle<()>,
}

impl TestServer {
    pub(crate) async fn start(replies: Vec<Reply>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let queue = Arc::new(Mutex::new(VecDeque::from(replies)));
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let rec = recorded.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let queue = queue.clone();
                let rec = rec.clone();
                tokio::spawn(async move {
                    let _ = handle(stream, queue, rec).await;
                });
            }
        });
        TestServer {
            addr,
            recorded,
            task,
        }
    }

    pub(crate) fn addr(&self) -> SocketAddr {
        self.addr
    }

    pub(crate) fn requests(&self) -> Vec<Recorded> {
        self.recorded.lock().clone()
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn handle(
    mut stream: TcpStream,
    queue: Arc<Mutex<VecDeque<Reply>>>,
    rec: Arc<Mutex<Vec<Recorded>>>,
) -> std::io::Result<()> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    let head_end = loop {
        let n = stream.read(&mut tmp).await?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split(' ');
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    let len: usize = headers
        .iter()
        .find(|(k, _)| k == "content-length")
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    let mut body = buf[head_end..].to_vec();
    while body.len() < len {
        let n = stream.read(&mut tmp).await?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&tmp[..n]);
    }
    rec.lock().push(Recorded {
        method,
        path,
        headers,
        body,
    });
    let reply = queue
        .lock()
        .pop_front()
        .unwrap_or_else(|| Reply::new(500, "text/plain", "no scripted reply"));
    let mut out = format!("HTTP/1.1 {} X\r\nconnection: close\r\n", reply.status);
    for (k, v) in &reply.headers {
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    if reply.chunked {
        out.push_str("transfer-encoding: chunked\r\n\r\n");
        stream.write_all(out.as_bytes()).await?;
        for chunk in reply.body.chunks(256) {
            stream
                .write_all(format!("{:x}\r\n", chunk.len()).as_bytes())
                .await?;
            stream.write_all(chunk).await?;
            stream.write_all(b"\r\n").await?;
        }
        stream.write_all(b"0\r\n\r\n").await?;
    } else {
        out.push_str(&format!("content-length: {}\r\n\r\n", reply.body.len()));
        stream.write_all(out.as_bytes()).await?;
        stream.write_all(&reply.body).await?;
    }
    stream.flush().await?;
    let _ = stream.shutdown().await;
    Ok(())
}
