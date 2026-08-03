//! Conservative shell command analysis backed by tree-sitter-bash.

use tree_sitter::Parser;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BashCommand {
    pub argv: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BashAnalysis {
    pub status: &'static str,
    pub commands: Vec<BashCommand>,
    pub has_pipeline: bool,
    pub has_redirection: bool,
}

/// Parse only the shell subset for which command boundaries and argv are
/// unambiguous. Callers must treat every other status as requiring approval.
pub fn analyze_bash_command(source: &str) -> BashAnalysis {
    let mut parser = Parser::new();
    let language = crate::language::SupportLang::Bash.get_ts_language();
    if parser.set_language(&language).is_err() {
        return unavailable();
    }
    let Some(tree) = parser.parse(source, None) else {
        return unavailable();
    };
    if tree.root_node().has_error() {
        return complex();
    }
    tokenize(source).unwrap_or_else(|_| complex())
}

fn unavailable() -> BashAnalysis {
    BashAnalysis { status: "parse-unavailable", commands: Vec::new(), has_pipeline: false, has_redirection: false }
}

fn complex() -> BashAnalysis {
    BashAnalysis { status: "too-complex", commands: Vec::new(), has_pipeline: false, has_redirection: false }
}

fn tokenize(source: &str) -> Result<BashAnalysis, ()> {
    let mut commands = Vec::new();
    let mut argv = Vec::new();
    let mut word = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    let mut has_pipeline = false;
    let mut has_redirection = false;
    let chars: Vec<char> = source.chars().collect();
    let mut index = 0;

    let push_word = |argv: &mut Vec<String>, word: &mut String| {
        if !word.is_empty() {
            argv.push(std::mem::take(word));
        }
    };
    let push_command = |commands: &mut Vec<BashCommand>, argv: &mut Vec<String>| {
        while argv.first().is_some_and(|value| is_assignment(value)) {
            argv.remove(0);
        }
        if !argv.is_empty() {
            commands.push(BashCommand { argv: std::mem::take(argv) });
        }
    };

    while index < chars.len() {
        let current = chars[index];
        if escaped {
            word.push(current);
            escaped = false;
            index += 1;
            continue;
        }
        if let Some(active_quote) = quote {
            match current {
                '\\' if active_quote == '"' => escaped = true,
                value if value == active_quote => quote = None,
                '`' if active_quote == '"' => return Err(()),
                _ => word.push(current),
            }
            index += 1;
            continue;
        }
        match current {
            '\\' => escaped = true,
            '\'' | '"' => quote = Some(current),
            '$' if chars.get(index + 1) == Some(&'(') => return Err(()),
            '`' | '(' | ')' | '{' | '}' => return Err(()),
            '#' if word.is_empty() && argv.is_empty() => {
                while index < chars.len() && chars[index] != '\n' { index += 1; }
                continue;
            }
            value if value.is_whitespace() => push_word(&mut argv, &mut word),
            ';' | '\n' => {
                push_word(&mut argv, &mut word);
                push_command(&mut commands, &mut argv);
            }
            '&' => {
                push_word(&mut argv, &mut word);
                if chars.get(index + 1) == Some(&'&') { index += 1; }
                push_command(&mut commands, &mut argv);
            }
            '|' => {
                push_word(&mut argv, &mut word);
                if chars.get(index + 1) == Some(&'|') { index += 1; } else { has_pipeline = true; }
                push_command(&mut commands, &mut argv);
            }
            '>' | '<' => {
                push_word(&mut argv, &mut word);
                has_redirection = true;
                while matches!(chars.get(index + 1), Some('>') | Some('<') | Some('&')) { index += 1; }
                while chars.get(index + 1).is_some_and(|value| value.is_whitespace()) { index += 1; }
                index += 1;
                while index < chars.len() && !chars[index].is_whitespace() && !";&|<>".contains(chars[index]) { index += 1; }
                index = index.saturating_sub(1);
            }
            _ => word.push(current),
        }
        index += 1;
    }
    if quote.is_some() || escaped { return Err(()); }
    push_word(&mut argv, &mut word);
    push_command(&mut commands, &mut argv);
    if commands.is_empty() { return Err(()); }
    Ok(BashAnalysis { status: "simple", commands, has_pipeline, has_redirection })
}

fn is_assignment(value: &str) -> bool {
    let Some((name, _)) = value.split_once('=') else { return false; };
    !name.is_empty() && name.chars().enumerate().all(|(index, c)| c == '_' || c.is_ascii_alphabetic() || (index > 0 && c.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_each_simple_command_and_shell_features() {
        let analysis = analyze_bash_command("FOO=bar git commit -m 'message' && rg needle src | head -1 > out");
        assert_eq!(analysis.status, "simple");
        assert_eq!(analysis.commands[0].argv, ["git", "commit", "-m", "message"]);
        assert_eq!(analysis.commands[1].argv, ["rg", "needle", "src"]);
        assert_eq!(analysis.commands[2].argv, ["head", "-1"]);
        assert!(analysis.has_pipeline);
        assert!(analysis.has_redirection);
    }

    #[test]
    fn rejects_command_substitution() {
        assert_eq!(analyze_bash_command("echo $(whoami)").status, "too-complex");
    }
}
