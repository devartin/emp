//! Private-address blocking (SPEC §9.18) and the vetting DNS resolver.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use reqwest::dns::{Addrs, Name, Resolve, Resolving};

/// Whether `ip` is in a range EMP never connects to: loopback, RFC 1918, link-local,
/// CGNAT, "this network", ULA, multicast, broadcast and reserved space. IPv4-mapped and
/// NAT64 IPv6 addresses are checked by their embedded IPv4 address.
pub fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_v4(v4),
        IpAddr::V6(v6) => is_blocked_v6(v6),
    }
}

fn is_blocked_v4(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    a == 0                                   // 0/8
        || a == 10                           // 10/8
        || a == 127                          // 127/8
        || (a == 100 && (64..=127).contains(&b)) // 100.64/10
        || (a == 169 && b == 254)            // 169.254/16
        || (a == 172 && (16..=31).contains(&b)) // 172.16/12
        || (a == 192 && b == 168)            // 192.168/16
        || (a == 192 && b == 0 && ip.octets()[2] == 0) // 192.0.0/24 IETF protocol assignments
        || a >= 224 // multicast 224/4, reserved 240/4, broadcast
}

fn is_blocked_v6(ip: Ipv6Addr) -> bool {
    if ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() {
        return true;
    }
    let seg = ip.segments();
    // fc00::/7 unique local, fe80::/10 link-local
    if (seg[0] & 0xfe00) == 0xfc00 || (seg[0] & 0xffc0) == 0xfe80 {
        return true;
    }
    // ::ffff:0:0/96 IPv4-mapped
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_blocked_v4(v4);
    }
    // 64:ff9b::/96 NAT64
    if seg[0] == 0x64 && seg[1] == 0xff9b && seg[2..6].iter().all(|s| *s == 0) {
        let v4 = Ipv4Addr::new(
            (seg[6] >> 8) as u8,
            (seg[6] & 0xff) as u8,
            (seg[7] >> 8) as u8,
            (seg[7] & 0xff) as u8,
        );
        return is_blocked_v4(v4);
    }
    // ::/96 IPv4-compatible (deprecated)
    if seg[0..6].iter().all(|s| *s == 0) {
        return true;
    }
    false
}

/// Keep only public addresses. Returns `None` when nothing is left.
pub fn vet_addrs(addrs: impl IntoIterator<Item = SocketAddr>) -> Option<Vec<SocketAddr>> {
    let kept: Vec<SocketAddr> = addrs
        .into_iter()
        .filter(|a| !is_blocked_ip(a.ip()))
        .collect();
    if kept.is_empty() { None } else { Some(kept) }
}

/// DNS resolver installed on the NetGuard client: resolves with the system resolver, then
/// drops every blocked address so connections only go to vetted IPs.
#[derive(Debug, Default)]
pub(crate) struct VettingResolver {
    /// Test-only escape hatch for loopback servers.
    pub(crate) allow_private: bool,
}

impl Resolve for VettingResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let allow_private = self.allow_private;
        let host = name.as_str().to_string();
        Box::pin(async move {
            let resolved: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0))
                .await
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)?
                .collect();
            let kept = if allow_private {
                Some(resolved)
            } else {
                vet_addrs(resolved)
            };
            match kept {
                Some(v) if !v.is_empty() => Ok(Box::new(v.into_iter()) as Addrs),
                _ => Err(Box::new(BlockedHost(host)) as Box<dyn std::error::Error + Send + Sync>),
            }
        })
    }
}

/// Error raised by the resolver when every address is blocked.
#[derive(Debug)]
pub(crate) struct BlockedHost(pub(crate) String);

impl std::fmt::Display for BlockedHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} resolves only to blocked addresses", self.0)
    }
}

impl std::error::Error for BlockedHost {}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn blocks_spec_ranges() {
        for s in [
            "127.0.0.1",
            "127.255.255.254",
            "10.1.2.3",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "100.127.255.255",
            "0.0.0.0",
            "0.1.2.3",
            "::1",
            "::",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "febf::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "64:ff9b::a9fe:a9fe",
            "224.0.0.1",
            "255.255.255.255",
        ] {
            assert!(is_blocked_ip(ip(s)), "{s} should be blocked");
        }
    }

    #[test]
    fn allows_public_addresses() {
        for s in [
            "8.8.8.8",
            "172.15.255.255",
            "172.32.0.1",
            "100.63.255.255",
            "100.128.0.1",
            "142.250.1.1",
            "2607:f8b0:4005::200e",
            "::ffff:8.8.8.8",
            "fec0::1",
        ] {
            assert!(!is_blocked_ip(ip(s)), "{s} should be allowed");
        }
    }

    #[test]
    fn vet_drops_private_answers() {
        let mixed = vec![
            SocketAddr::new(ip("10.0.0.1"), 443),
            SocketAddr::new(ip("93.184.216.34"), 443),
        ];
        assert_eq!(vet_addrs(mixed).unwrap().len(), 1);
        assert!(vet_addrs(vec![SocketAddr::new(ip("127.0.0.1"), 443)]).is_none());
    }
}
