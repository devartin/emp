//! OFX/QFX statements (§9.16): 1.x via a tolerant SGML tokenizer (no DTD), 2.x via `quick-xml` with
//! entity resolution disabled (only the five predefined entities and numeric character references are
//! decoded; anything else, including DTD-declared entities, stays literal text).

use quick_xml::Reader;
use quick_xml::events::Event;

use super::amount::parse_amount;
use super::{
    ImportFormat, ImportOptions, ParsedStatement, StatementAccount, StatementBalance,
    StatementSection, StatementTxn,
};
use crate::error::{FinanceError, Result};
use chrono::NaiveDate;

/// A parsed OFX element.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Node {
    /// Upper-cased tag name.
    pub name: String,
    /// Text content for leaf elements.
    pub text: Option<String>,
    /// Child elements.
    pub children: Vec<Node>,
}

impl Node {
    fn child(&self, name: &str) -> Option<&Node> {
        self.children.iter().find(|c| c.name == name)
    }

    fn text_of(&self, name: &str) -> Option<String> {
        self.child(name)
            .and_then(|c| c.text.clone())
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
    }

    fn find_all<'a>(&'a self, name: &str, out: &mut Vec<&'a Node>) {
        for c in &self.children {
            if c.name == name {
                out.push(c);
            } else {
                c.find_all(name, out);
            }
        }
    }
}

struct TreeBuilder<'o> {
    stack: Vec<Node>,
    leaf_open: bool,
    nodes: usize,
    opts: &'o ImportOptions<'o>,
}

impl<'o> TreeBuilder<'o> {
    fn new(opts: &'o ImportOptions<'o>) -> Self {
        Self {
            stack: vec![Node {
                name: "#ROOT".into(),
                ..Node::default()
            }],
            leaf_open: false,
            nodes: 0,
            opts,
        }
    }

    fn pop_into_parent(&mut self) {
        if self.stack.len() > 1
            && let Some(n) = self.stack.pop()
            && let Some(p) = self.stack.last_mut()
        {
            p.children.push(n);
        }
    }

    fn close_implicit_leaf(&mut self) {
        if self.leaf_open {
            self.leaf_open = false;
            self.pop_into_parent();
        }
    }

    fn open(&mut self, name: &str) -> Result<()> {
        self.close_implicit_leaf();
        self.nodes += 1;
        if self.nodes.is_multiple_of(4096) {
            self.opts.check_cancel()?;
        }
        if self.nodes > self.opts.limits.max_rows.saturating_mul(32).max(1024) {
            return Err(FinanceError::TooLarge("too many OFX elements".into()));
        }
        if self.stack.len() > self.opts.limits.max_depth {
            return Err(FinanceError::TooLarge("OFX nesting too deep".into()));
        }
        self.stack.push(Node {
            name: name.to_ascii_uppercase(),
            ..Node::default()
        });
        Ok(())
    }

    fn text(&mut self, t: &str, sgml: bool) -> Result<()> {
        if self.stack.len() <= 1 {
            return Ok(());
        }
        let Some(top) = self.stack.last_mut() else {
            return Ok(());
        };
        // Whitespace only matters between pieces of the same XML text node ("a &amp; b").
        if t.trim().is_empty() && (sgml || top.text.is_none()) {
            return Ok(());
        }
        let cur = top.text.get_or_insert_with(String::new);
        cur.push_str(t);
        if cur.len() > self.opts.limits.max_field_bytes {
            return Err(FinanceError::TooLarge("OFX text field too long".into()));
        }
        if sgml {
            self.leaf_open = true;
        }
        Ok(())
    }

    fn close(&mut self, name: &str) {
        let name = name.to_ascii_uppercase();
        if self.leaf_open {
            self.leaf_open = false;
            if self.stack.last().is_some_and(|n| n.name == name) {
                self.pop_into_parent();
                return;
            }
            self.pop_into_parent();
        }
        // Tolerant: pop until the matching element; ignore stray closes.
        if let Some(pos) = self.stack.iter().rposition(|n| n.name == name) {
            if pos == 0 {
                return;
            }
            while self.stack.len() > pos {
                self.pop_into_parent();
            }
        }
    }

    fn finish(mut self) -> Node {
        self.close_implicit_leaf();
        while self.stack.len() > 1 {
            self.pop_into_parent();
        }
        self.stack.pop().unwrap_or_default()
    }
}

fn decode_sgml_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

/// Tokenises OFX 1.x SGML (also accepts well-formed XML bodies).
pub fn parse_sgml(body: &str, opts: &ImportOptions<'_>) -> Result<Node> {
    let mut b = TreeBuilder::new(opts);
    let mut rest = body;
    while let Some(lt) = rest.find('<') {
        let text = &rest[..lt];
        b.text(&decode_sgml_entities(text), true)?;
        let after = &rest[lt + 1..];
        let Some(gt) = after.find('>') else { break };
        let tag = after[..gt].trim();
        rest = &after[gt + 1..];
        if tag.starts_with('!') || tag.starts_with('?') || tag.is_empty() {
            continue;
        }
        if let Some(name) = tag.strip_prefix('/') {
            b.close(name.trim());
        } else {
            let name = tag
                .split_whitespace()
                .next()
                .unwrap_or(tag)
                .trim_end_matches('/');
            b.open(name)?;
            if tag.ends_with('/') {
                b.close(name);
            }
        }
    }
    b.text(&decode_sgml_entities(rest), true)?;
    Ok(b.finish())
}

/// Parses OFX 2.x XML with `quick-xml`. DTDs are ignored; unknown entities are kept literally.
pub fn parse_xml(body: &str, opts: &ImportOptions<'_>, warnings: &mut Vec<String>) -> Result<Node> {
    let mut reader = Reader::from_str(body);
    reader.config_mut().trim_text(false);
    let mut b = TreeBuilder::new(opts);
    let xml_err = |e: quick_xml::Error, pos: u64| {
        FinanceError::parse(format!("malformed OFX XML at byte {pos}: {e}"))
    };
    loop {
        let pos = reader.buffer_position();
        match reader.read_event().map_err(|e| xml_err(e, pos))? {
            Event::Start(e) => b.open(e.name().as_ref())?,
            Event::End(e) => b.close(e.name().as_ref()),
            Event::Empty(e) => {
                let n = e.name().as_ref().to_owned();
                b.open(&n)?;
                b.close(&n);
            }
            Event::Text(t) => {
                b.text(&t.xml10_content(), false)?;
            }
            Event::CData(t) => {
                b.text(&t, false)?;
            }
            Event::GeneralRef(r) => {
                let name = r.to_string();
                let resolved = match name.as_str() {
                    "amp" => "&".to_string(),
                    "lt" => "<".to_string(),
                    "gt" => ">".to_string(),
                    "quot" => "\"".to_string(),
                    "apos" => "'".to_string(),
                    _ => match r.resolve_char_ref() {
                        Ok(Some(c)) => c.to_string(),
                        _ => format!("&{name};"),
                    },
                };
                b.text(&resolved, false)?;
            }
            Event::DocType(_) => {
                warnings.push("Ignored a DOCTYPE declaration (entities are never expanded)".into())
            }
            Event::Eof => break,
            Event::Decl(_) | Event::PI(_) | Event::Comment(_) => {}
        }
    }
    Ok(b.finish())
}

/// Parses an OFX date (`YYYYMMDD[HHMMSS[.XXX]][[±H:TZ]]`); only the calendar date is kept.
pub fn parse_ofx_date(s: &str) -> Option<NaiveDate> {
    let t = s.trim();
    if t.len() < 8 || !t.as_bytes()[..8].iter().all(u8::is_ascii_digit) {
        return None;
    }
    NaiveDate::from_ymd_opt(
        t[..4].parse().ok()?,
        t[4..6].parse().ok()?,
        t[6..8].parse().ok()?,
    )
}

fn ofx_amount(s: &str) -> Result<rust_decimal::Decimal> {
    // Some institutions emit decimal commas ("-12,50").
    let dc = s.contains(',') && !s.contains('.');
    parse_amount(s, dc)
}

fn section_from(stmt: &Node, next_idx: &mut usize, warnings: &mut Vec<String>) -> StatementSection {
    let acct_node = stmt
        .child("BANKACCTFROM")
        .or_else(|| stmt.child("CCACCTFROM"));
    let account = acct_node.map(|a| StatementAccount {
        bank_id: a.text_of("BANKID"),
        account_id: a.text_of("ACCTID"),
        account_type: a
            .text_of("ACCTTYPE")
            .or_else(|| (a.name == "CCACCTFROM").then(|| "CREDITCARD".to_string())),
        currency: stmt.text_of("CURDEF"),
        name: None,
    });
    let mut trns = Vec::new();
    if let Some(list) = stmt.child("BANKTRANLIST") {
        list.find_all("STMTTRN", &mut trns);
    }
    let mut transactions = Vec::with_capacity(trns.len());
    for t in trns {
        let idx = *next_idx;
        *next_idx += 1;
        let fitid = t.text_of("FITID");
        let date = t
            .text_of("DTPOSTED")
            .or_else(|| t.text_of("DTUSER"))
            .and_then(|d| parse_ofx_date(&d));
        let amount = t.text_of("TRNAMT").map(|a| ofx_amount(&a));
        let (date, amount) = match (date, amount) {
            (Some(d), Some(Ok(a))) => (d, a),
            (None, _) => {
                warnings.push(format!(
                    "Transaction {} skipped: missing or invalid date",
                    fitid.as_deref().unwrap_or("?")
                ));
                continue;
            }
            (_, Some(Err(e))) => {
                warnings.push(format!(
                    "Transaction {} skipped: {e}",
                    fitid.as_deref().unwrap_or("?")
                ));
                continue;
            }
            (_, None) => {
                warnings.push(format!(
                    "Transaction {} skipped: missing amount",
                    fitid.as_deref().unwrap_or("?")
                ));
                continue;
            }
        };
        let payee = t
            .text_of("NAME")
            .or_else(|| t.child("PAYEE").and_then(|p| p.text_of("NAME")))
            .unwrap_or_default();
        let memo = t.text_of("MEMO");
        let mut row = StatementTxn::new(
            idx,
            date,
            amount,
            if payee.is_empty() {
                memo.clone().unwrap_or_default()
            } else {
                payee
            },
        );
        row.memo = memo;
        row.fitid = fitid;
        row.check_number = t.text_of("CHECKNUM");
        row.trn_type = t.text_of("TRNTYPE");
        transactions.push(row);
    }
    let ledger_balance = stmt.child("LEDGERBAL").and_then(|lb| {
        let amount = lb.text_of("BALAMT").and_then(|a| ofx_amount(&a).ok())?;
        Some(StatementBalance {
            amount,
            date: lb.text_of("DTASOF").and_then(|d| parse_ofx_date(&d)),
        })
    });
    StatementSection {
        account,
        transactions,
        ledger_balance,
    }
}

/// Splits the OFX 1.x header (`KEY:VALUE` lines) from the body.
fn split_v1(text: &str) -> &str {
    text.find('<').map_or("", |i| &text[i..])
}

/// Parses an OFX/QFX document (either version) into statement sections.
pub fn parse(text: &str, opts: &ImportOptions<'_>) -> Result<ParsedStatement> {
    let trimmed = text.trim_start_matches(['\u{feff}', ' ', '\t', '\r', '\n']);
    let mut warnings = Vec::new();
    let root = if trimmed.starts_with("<?xml") || trimmed.starts_with("<?XML") {
        parse_xml(trimmed, opts, &mut warnings)?
    } else {
        parse_sgml(split_v1(trimmed), opts)?
    };
    let mut stmts = Vec::new();
    root.find_all("STMTRS", &mut stmts);
    root.find_all("CCSTMTRS", &mut stmts);
    let mut inv = Vec::new();
    root.find_all("INVSTMTRS", &mut inv);
    if !inv.is_empty() {
        warnings.push(
            "Investment statements in this file were not imported (use the Portfolio importer)"
                .into(),
        );
    }
    if stmts.is_empty() && inv.is_empty() {
        return Err(FinanceError::parse(
            "no bank or credit-card statement found in the OFX file",
        ));
    }
    let mut next = 0usize;
    let sections = stmts
        .into_iter()
        .map(|s| section_from(s, &mut next, &mut warnings))
        .collect();
    Ok(ParsedStatement {
        format: ImportFormat::Ofx,
        encoding: String::new(),
        sections,
        warnings,
        date_ambiguity: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const V1: &str = "OFXHEADER:100\r\nDATA:OFXSGML\r\nVERSION:102\r\nCHARSET:1252\r\n\r\n<OFX><SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20260131120000</SONRS></SIGNONMSGSRSV1>\
<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STMTRS><CURDEF>USD<BANKACCTFROM><BANKID>123456789<ACCTID>000111222333<ACCTTYPE>CHECKING</BANKACCTFROM>\
<BANKTRANLIST><DTSTART>20260101<DTEND>20260131\
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260105120000.000[-5:EST]<TRNAMT>-4.50<FITID>A1<NAME>STARBUCKS &amp; CO<MEMO>coffee</STMTTRN>\
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260115<TRNAMT>2500.00<FITID>A2<NAME>PAYROLL</STMTTRN>\
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>2026XX15<TRNAMT>-1.00<FITID>BAD</STMTTRN>\
</BANKTRANLIST><LEDGERBAL><BALAMT>3495.50<DTASOF>20260131</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>";

    #[test]
    fn sgml_v1() {
        let st = parse(V1, &ImportOptions::default()).unwrap();
        assert_eq!(st.sections.len(), 1);
        let s = &st.sections[0];
        let a = s.account.as_ref().unwrap();
        assert_eq!(a.account_id.as_deref(), Some("000111222333"));
        assert_eq!(a.last4().as_deref(), Some("2333"));
        assert_eq!(a.currency.as_deref(), Some("USD"));
        assert_eq!(s.transactions.len(), 2);
        assert_eq!(s.transactions[0].payee, "STARBUCKS & CO");
        assert_eq!(s.transactions[0].date.to_string(), "2026-01-05");
        assert_eq!(s.transactions[0].fitid.as_deref(), Some("A1"));
        assert_eq!(s.transactions[1].amount, "2500.00".parse().unwrap());
        assert_eq!(
            s.ledger_balance.as_ref().unwrap().amount,
            "3495.50".parse().unwrap()
        );
        assert_eq!(st.warnings.len(), 1, "{:?}", st.warnings);
    }

    #[test]
    fn xml_v2_and_no_entity_expansion() {
        let x = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE OFX [<!ENTITY xxe SYSTEM "file:///etc/passwd"><!ENTITY boom "BOOM">]>
<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>EUR</CURDEF><CCACCTFROM><ACCTID>4111XXXX1111</ACCTID></CCACCTFROM>
<BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260203</DTPOSTED><TRNAMT>-12.30</TRNAMT><FITID>X1</FITID>
<NAME>Caf&#233; &amp; &xxe;&boom;</NAME></STMTTRN></BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>"#;
        let st = parse(x, &ImportOptions::default()).unwrap();
        let t = &st.sections[0].transactions[0];
        assert_eq!(t.payee, "Café & &xxe;&boom;");
        assert!(!t.payee.contains("BOOM") && !t.payee.contains("root:"));
        assert_eq!(
            st.sections[0]
                .account
                .as_ref()
                .unwrap()
                .account_type
                .as_deref(),
            Some("CREDITCARD")
        );
        assert!(st.warnings.iter().any(|w| w.contains("DOCTYPE")));
    }

    #[test]
    fn depth_limit_and_garbage() {
        let deep = format!("OFXHEADER:100\n\n{}", "<A>".repeat(200));
        assert!(matches!(
            parse(&deep, &ImportOptions::default()),
            Err(FinanceError::TooLarge(_))
        ));
        assert!(parse("OFXHEADER:100\n\n<OFX></OFX>", &ImportOptions::default()).is_err());
        assert!(
            parse(
                "<?xml version=\"1.0\"?><?OFX?><OFX><unclosed>",
                &ImportOptions::default()
            )
            .is_err()
        );
    }

    #[test]
    fn dates() {
        assert_eq!(
            parse_ofx_date("20260105120000.000[-5:EST]")
                .unwrap()
                .to_string(),
            "2026-01-05"
        );
        assert!(parse_ofx_date("2026").is_none());
        assert!(parse_ofx_date("20261340").is_none());
    }
}
