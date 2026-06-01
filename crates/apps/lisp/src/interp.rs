//! A complete Scheme-like Lisp interpreter — the runtime behind the flagship app.
//!
//! Pure Rust (no wasm-specific code), so it is unit-tested on the host. Pipeline:
//! `tokenize` → `parse` (s-expressions) → `eval` over a lexically-scoped
//! environment with first-class closures. Supports integers + floats, booleans,
//! strings, symbols, proper lists (cons cells), `lambda`/`define`/`let`/`if`/
//! `cond`/`and`/`or`/`begin`/`quote`/`set!`, recursion, and a standard library of
//! arithmetic, comparison, list, and predicate procedures.

use std::cell::RefCell;
use std::collections::HashMap;
use std::fmt;
use std::rc::Rc;

/// A Lisp value. Lists are chains of immutable cons `Pair`s ending in `Nil`.
#[derive(Clone)]
pub enum Value {
    Int(i64),
    Float(f64),
    Bool(bool),
    Str(Rc<String>),
    Sym(Rc<String>),
    Nil,
    Pair(Rc<(Value, Value)>),
    Builtin(&'static str, fn(&[Value]) -> Result<Value, String>),
    Lambda(Rc<Lambda>),
    /// The result of side-effecting forms (`define`, `set!`, `display`).
    Unspecified,
}

pub struct Lambda {
    pub params: Vec<String>,
    /// Name bound to a rest-list (variadic `(lambda args ...)` / `(lambda (a . rest) ...)`).
    pub rest: Option<String>,
    pub body: Vec<Value>,
    pub env: Env,
}

/// A lexical scope: its own bindings plus a parent (None for the global scope).
pub struct Scope {
    vars: HashMap<String, Value>,
    parent: Option<Env>,
}
pub type Env = Rc<RefCell<Scope>>;

fn child_env(parent: &Env) -> Env {
    Rc::new(RefCell::new(Scope { vars: HashMap::new(), parent: Some(parent.clone()) }))
}

impl Scope {
    fn lookup(&self, name: &str) -> Option<Value> {
        if let Some(v) = self.vars.get(name) {
            Some(v.clone())
        } else if let Some(p) = &self.parent {
            p.borrow().lookup(name)
        } else {
            None
        }
    }
    /// Assign an existing binding (`set!`), searching up the scope chain.
    fn set(&mut self, name: &str, val: Value) -> Result<(), String> {
        if self.vars.contains_key(name) {
            self.vars.insert(name.to_string(), val);
            Ok(())
        } else if let Some(p) = &self.parent {
            p.borrow_mut().set(name, val)
        } else {
            Err(format!("set!: unbound variable: {name}"))
        }
    }
}

// ---------------------------------------------------------------------------
// Reader: tokenize + parse
// ---------------------------------------------------------------------------

fn tokenize(src: &str) -> Vec<String> {
    let mut toks = Vec::new();
    let mut chars = src.chars().peekable();
    while let Some(&c) = chars.peek() {
        match c {
            c if c.is_whitespace() => {
                chars.next();
            }
            ';' => {
                // Line comment.
                while let Some(&c) = chars.peek() {
                    chars.next();
                    if c == '\n' {
                        break;
                    }
                }
            }
            '(' | ')' | '\'' => {
                toks.push(c.to_string());
                chars.next();
            }
            '"' => {
                chars.next();
                let mut s = String::from("\"");
                while let Some(&c) = chars.peek() {
                    chars.next();
                    if c == '\\' {
                        if let Some(&e) = chars.peek() {
                            chars.next();
                            s.push(match e {
                                'n' => '\n',
                                't' => '\t',
                                _ => e,
                            });
                        }
                    } else if c == '"' {
                        break;
                    } else {
                        s.push(c);
                    }
                }
                s.push('"');
                toks.push(s);
            }
            _ => {
                let mut atom = String::new();
                while let Some(&c) = chars.peek() {
                    if c.is_whitespace() || c == '(' || c == ')' || c == ';' {
                        break;
                    }
                    atom.push(c);
                    chars.next();
                }
                toks.push(atom);
            }
        }
    }
    toks
}

/// Parse all top-level forms from `src`.
pub fn parse(src: &str) -> Result<Vec<Value>, String> {
    let toks = tokenize(src);
    let mut pos = 0;
    let mut forms = Vec::new();
    while pos < toks.len() {
        let v = parse_form(&toks, &mut pos)?;
        forms.push(v);
    }
    Ok(forms)
}

fn parse_form(toks: &[String], pos: &mut usize) -> Result<Value, String> {
    if *pos >= toks.len() {
        return Err("unexpected end of input".to_string());
    }
    let t = &toks[*pos];
    *pos += 1;
    match t.as_str() {
        "(" => {
            let mut items = Vec::new();
            while *pos < toks.len() && toks[*pos] != ")" {
                items.push(parse_form(toks, pos)?);
            }
            if *pos >= toks.len() {
                return Err("missing )".to_string());
            }
            *pos += 1; // consume ")"
            Ok(list_from(items))
        }
        ")" => Err("unexpected )".to_string()),
        "'" => Ok(list_from(vec![Value::sym("quote"), parse_form(toks, pos)?])),
        _ => Ok(atom(t)),
    }
}

fn atom(t: &str) -> Value {
    if let Some(inner) = t.strip_prefix('"') {
        return Value::Str(Rc::new(inner.strip_suffix('"').unwrap_or(inner).to_string()));
    }
    match t {
        "#t" => return Value::Bool(true),
        "#f" => return Value::Bool(false),
        _ => {}
    }
    if let Ok(i) = t.parse::<i64>() {
        Value::Int(i)
    } else if let Ok(f) = t.parse::<f64>() {
        Value::Float(f)
    } else {
        Value::sym(t)
    }
}

// ---------------------------------------------------------------------------
// List helpers (proper lists over cons pairs)
// ---------------------------------------------------------------------------

fn list_from(items: Vec<Value>) -> Value {
    let mut v = Value::Nil;
    for item in items.into_iter().rev() {
        v = Value::Pair(Rc::new((item, v)));
    }
    v
}

/// Collect a proper list into a Vec; errors on an improper list. Walks by cloning
/// the cdr each step (an `Rc` clone — cheap), which sidesteps borrow lifetimes.
fn list_to_vec(v: &Value) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    let mut cur = v.clone();
    loop {
        match cur {
            Value::Nil => return Ok(out),
            Value::Pair(p) => {
                out.push(p.0.clone());
                cur = p.1.clone();
            }
            _ => return Err("improper list".to_string()),
        }
    }
}

impl Value {
    pub fn sym(s: &str) -> Value {
        Value::Sym(Rc::new(s.to_string()))
    }
    fn truthy(&self) -> bool {
        !matches!(self, Value::Bool(false))
    }
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

pub fn eval(expr: &Value, env: &Env) -> Result<Value, String> {
    match expr {
        Value::Int(_)
        | Value::Float(_)
        | Value::Bool(_)
        | Value::Str(_)
        | Value::Nil
        | Value::Builtin(..)
        | Value::Lambda(_)
        | Value::Unspecified => Ok(expr.clone()),
        Value::Sym(s) => env
            .borrow()
            .lookup(s)
            .ok_or_else(|| format!("unbound variable: {s}")),
        Value::Pair(_) => {
            let items = list_to_vec(expr)?;
            let (head, args) = items.split_first().ok_or("empty application")?;
            if let Value::Sym(s) = head {
                match s.as_str() {
                    "quote" => return Ok(args.first().cloned().unwrap_or(Value::Nil)),
                    "if" => return eval_if(args, env),
                    "define" => return eval_define(args, env),
                    "set!" => return eval_set(args, env),
                    "lambda" | "\u{3bb}" => return eval_lambda(args, env),
                    "let" => return eval_let(args, env, false),
                    "let*" => return eval_let(args, env, true),
                    "begin" => return eval_begin(args, env),
                    "cond" => return eval_cond(args, env),
                    "and" => return eval_and(args, env),
                    "or" => return eval_or(args, env),
                    _ => {}
                }
            }
            // Procedure application.
            let proc = eval(head, env)?;
            let mut argv = Vec::with_capacity(args.len());
            for a in args {
                argv.push(eval(a, env)?);
            }
            apply(&proc, &argv)
        }
    }
}

pub fn apply(proc: &Value, args: &[Value]) -> Result<Value, String> {
    match proc {
        Value::Builtin(_, f) => f(args),
        Value::Lambda(l) => {
            let local = child_env(&l.env);
            if l.rest.is_none() && args.len() != l.params.len() {
                return Err(format!("expected {} args, got {}", l.params.len(), args.len()));
            }
            if l.rest.is_some() && args.len() < l.params.len() {
                return Err(format!("expected at least {} args, got {}", l.params.len(), args.len()));
            }
            for (p, a) in l.params.iter().zip(args.iter()) {
                local.borrow_mut().vars.insert(p.clone(), a.clone());
            }
            if let Some(rest) = &l.rest {
                let extra = list_from(args[l.params.len()..].to_vec());
                local.borrow_mut().vars.insert(rest.clone(), extra);
            }
            let mut result = Value::Unspecified;
            for form in &l.body {
                result = eval(form, &local)?;
            }
            Ok(result)
        }
        _ => Err("not a procedure".to_string()),
    }
}

fn eval_if(args: &[Value], env: &Env) -> Result<Value, String> {
    let test = args.first().ok_or("if: missing test")?;
    if eval(test, env)?.truthy() {
        eval(args.get(1).ok_or("if: missing then")?, env)
    } else if let Some(else_branch) = args.get(2) {
        eval(else_branch, env)
    } else {
        Ok(Value::Unspecified)
    }
}

fn eval_define(args: &[Value], env: &Env) -> Result<Value, String> {
    match args.first() {
        // (define name value)
        Some(Value::Sym(name)) => {
            let val = args.get(1).map(|v| eval(v, env)).transpose()?.unwrap_or(Value::Unspecified);
            env.borrow_mut().vars.insert(name.to_string(), val);
            Ok(Value::Unspecified)
        }
        // (define (name params...) body...) — function shorthand.
        Some(Value::Pair(_)) => {
            let sig = list_to_vec(&args[0])?;
            let (name, params) = sig.split_first().ok_or("define: empty signature")?;
            let Value::Sym(name) = name else { return Err("define: bad name".to_string()) };
            let lam = make_lambda(params, &args[1..], env)?;
            env.borrow_mut().vars.insert(name.to_string(), lam);
            Ok(Value::Unspecified)
        }
        _ => Err("define: bad form".to_string()),
    }
}

fn eval_set(args: &[Value], env: &Env) -> Result<Value, String> {
    let Some(Value::Sym(name)) = args.first() else { return Err("set!: bad variable".to_string()) };
    let val = eval(args.get(1).ok_or("set!: missing value")?, env)?;
    env.borrow_mut().set(name, val)?;
    Ok(Value::Unspecified)
}

fn eval_lambda(args: &[Value], env: &Env) -> Result<Value, String> {
    let formals = args.first().ok_or("lambda: missing params")?;
    make_lambda_from_formals(formals, &args[1..], env)
}

fn make_lambda(params: &[Value], body: &[Value], env: &Env) -> Result<Value, String> {
    let mut names = Vec::new();
    for p in params {
        if let Value::Sym(s) = p {
            names.push(s.to_string());
        } else {
            return Err("lambda: bad parameter".to_string());
        }
    }
    Ok(Value::Lambda(Rc::new(Lambda { params: names, rest: None, body: body.to_vec(), env: env.clone() })))
}

fn make_lambda_from_formals(formals: &Value, body: &[Value], env: &Env) -> Result<Value, String> {
    match formals {
        // (lambda args body) — all arguments collected into `args`.
        Value::Sym(s) => Ok(Value::Lambda(Rc::new(Lambda {
            params: Vec::new(),
            rest: Some(s.to_string()),
            body: body.to_vec(),
            env: env.clone(),
        }))),
        _ => {
            let params = list_to_vec(formals)?;
            make_lambda(&params, body, env)
        }
    }
}

fn eval_let(args: &[Value], env: &Env, sequential: bool) -> Result<Value, String> {
    let bindings = list_to_vec(args.first().ok_or("let: missing bindings")?)?;
    let local = child_env(env);
    for b in &bindings {
        let pair = list_to_vec(b)?;
        let Some(Value::Sym(name)) = pair.first() else { return Err("let: bad binding".to_string()) };
        // let* evaluates each init in the growing scope; let in the outer scope.
        let init_env = if sequential { &local } else { env };
        let val = pair.get(1).map(|v| eval(v, init_env)).transpose()?.unwrap_or(Value::Unspecified);
        local.borrow_mut().vars.insert(name.to_string(), val);
    }
    let mut result = Value::Unspecified;
    for form in &args[1..] {
        result = eval(form, &local)?;
    }
    Ok(result)
}

fn eval_begin(args: &[Value], env: &Env) -> Result<Value, String> {
    let mut result = Value::Unspecified;
    for form in args {
        result = eval(form, env)?;
    }
    Ok(result)
}

fn eval_cond(args: &[Value], env: &Env) -> Result<Value, String> {
    for clause in args {
        let parts = list_to_vec(clause)?;
        let test = parts.first().ok_or("cond: empty clause")?;
        let is_else = matches!(test, Value::Sym(s) if s.as_str() == "else");
        if is_else || eval(test, env)?.truthy() {
            let mut result = if is_else { Value::Unspecified } else { eval(test, env)? };
            for form in &parts[1..] {
                result = eval(form, env)?;
            }
            return Ok(result);
        }
    }
    Ok(Value::Unspecified)
}

fn eval_and(args: &[Value], env: &Env) -> Result<Value, String> {
    let mut result = Value::Bool(true);
    for a in args {
        result = eval(a, env)?;
        if !result.truthy() {
            return Ok(Value::Bool(false));
        }
    }
    Ok(result)
}

fn eval_or(args: &[Value], env: &Env) -> Result<Value, String> {
    for a in args {
        let v = eval(a, env)?;
        if v.truthy() {
            return Ok(v);
        }
    }
    Ok(Value::Bool(false))
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

impl fmt::Display for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Value::Int(i) => write!(f, "{i}"),
            Value::Float(x) => {
                if x.fract() == 0.0 && x.is_finite() {
                    write!(f, "{x:.1}")
                } else {
                    write!(f, "{x}")
                }
            }
            Value::Bool(b) => write!(f, "{}", if *b { "#t" } else { "#f" }),
            Value::Str(s) => write!(f, "\"{s}\""),
            Value::Sym(s) => write!(f, "{s}"),
            Value::Nil => write!(f, "()"),
            Value::Pair(_) => {
                write!(f, "(")?;
                let mut cur = self.clone();
                let mut first = true;
                loop {
                    match cur {
                        Value::Pair(p) => {
                            if !first {
                                write!(f, " ")?;
                            }
                            first = false;
                            write!(f, "{}", p.0)?;
                            cur = p.1.clone();
                        }
                        Value::Nil => break,
                        other => {
                            write!(f, " . {other}")?;
                            break;
                        }
                    }
                }
                write!(f, ")")
            }
            Value::Builtin(name, _) => write!(f, "#<procedure:{name}>"),
            Value::Lambda(_) => write!(f, "#<procedure>"),
            Value::Unspecified => Ok(()),
        }
    }
}

/// How a value renders when produced by `display`/`write` to output (strings
/// without quotes for `display`).
pub fn display_str(v: &Value) -> String {
    match v {
        Value::Str(s) => s.to_string(),
        _ => format!("{v}"),
    }
}

// ---------------------------------------------------------------------------
// Numeric helpers + builtins
// ---------------------------------------------------------------------------

fn as_f64(v: &Value) -> Result<f64, String> {
    match v {
        Value::Int(i) => Ok(*i as f64),
        Value::Float(x) => Ok(*x),
        _ => Err(format!("expected a number, got {v}")),
    }
}

/// True if every operand is an integer (keeps integer arithmetic exact).
fn all_int(args: &[Value]) -> bool {
    args.iter().all(|v| matches!(v, Value::Int(_)))
}

fn num_fold(args: &[Value], int0: i64, fl0: f64, fi: fn(i64, i64) -> i64, ff: fn(f64, f64) -> f64) -> Result<Value, String> {
    if all_int(args) {
        let mut acc = int0;
        let mut started = false;
        for v in args {
            if let Value::Int(i) = v {
                acc = if started { fi(acc, *i) } else { *i };
                started = true;
            }
        }
        if args.len() == 1 {
            // Unary (e.g. (- 5) = -5, (/ 2) = 1/2 → float).
            return Ok(Value::Int(fi(int0, acc)));
        }
        Ok(Value::Int(if started { acc } else { int0 }))
    } else {
        let mut acc = fl0;
        let mut started = false;
        for v in args {
            let x = as_f64(v)?;
            acc = if started { ff(acc, x) } else { x };
            started = true;
        }
        if args.len() == 1 {
            return Ok(Value::Float(ff(fl0, acc)));
        }
        Ok(Value::Float(if started { acc } else { fl0 }))
    }
}

fn cmp_chain(args: &[Value], ok: fn(f64, f64) -> bool) -> Result<Value, String> {
    for w in args.windows(2) {
        if !ok(as_f64(&w[0])?, as_f64(&w[1])?) {
            return Ok(Value::Bool(false));
        }
    }
    Ok(Value::Bool(true))
}

fn equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Int(x), Value::Int(y)) => x == y,
        (Value::Float(x), Value::Float(y)) => x == y,
        (Value::Int(x), Value::Float(y)) | (Value::Float(y), Value::Int(x)) => *x as f64 == *y,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Str(x), Value::Str(y)) => x == y,
        (Value::Sym(x), Value::Sym(y)) => x == y,
        (Value::Nil, Value::Nil) => true,
        (Value::Pair(x), Value::Pair(y)) => equal(&x.0, &y.0) && equal(&x.1, &y.1),
        _ => false,
    }
}

// Output produced by `display`/`newline`, drained by the REPL after each eval.
thread_local! {
    static OUTPUT: RefCell<String> = const { RefCell::new(String::new()) };
}

/// Take and clear the buffered program output (M: the REPL prints it).
pub fn take_output() -> String {
    OUTPUT.with(|o| std::mem::take(&mut *o.borrow_mut()))
}

fn emit(s: &str) {
    OUTPUT.with(|o| o.borrow_mut().push_str(s));
}

macro_rules! b {
    ($env:expr, $name:expr, $f:expr) => {
        $env.borrow_mut().vars.insert($name.to_string(), Value::Builtin($name, $f));
    };
}

/// Build the global environment with the standard library bound.
pub fn global_env() -> Env {
    let env = Rc::new(RefCell::new(Scope { vars: HashMap::new(), parent: None }));

    b!(env, "+", |a| num_fold(a, 0, 0.0, |x, y| x + y, |x, y| x + y));
    b!(env, "*", |a| num_fold(a, 1, 1.0, |x, y| x * y, |x, y| x * y));
    b!(env, "-", |a| {
        if a.is_empty() {
            return Err("-: needs at least 1 arg".to_string());
        }
        if a.len() == 1 {
            return match &a[0] {
                Value::Int(i) => Ok(Value::Int(-i)),
                Value::Float(x) => Ok(Value::Float(-x)),
                _ => Err("-: expected a number".to_string()),
            };
        }
        num_fold(a, 0, 0.0, |x, y| x - y, |x, y| x - y)
    });
    b!(env, "/", |a| {
        if a.len() == 1 {
            return Ok(Value::Float(1.0 / as_f64(&a[0])?));
        }
        if a[1..].iter().any(|v| matches!(v, Value::Int(0))) || a[1..].iter().any(|v| as_f64(v).map(|x| x == 0.0).unwrap_or(false)) {
            return Err("/: division by zero".to_string());
        }
        // Integer division stays integer only when it divides evenly.
        if all_int(a) {
            let mut it = a.iter();
            let mut acc = if let Some(Value::Int(i)) = it.next() { *i } else { 0 };
            let mut exact = true;
            for v in it {
                if let Value::Int(i) = v {
                    if acc % i != 0 {
                        exact = false;
                        break;
                    }
                    acc /= i;
                }
            }
            if exact {
                return Ok(Value::Int(acc));
            }
        }
        // Inexact integer division (or any float operand) → float result. Must NOT
        // go through num_fold, which does exact integer division for all-int args.
        let mut acc = as_f64(&a[0])?;
        for v in &a[1..] {
            acc /= as_f64(v)?;
        }
        Ok(Value::Float(acc))
    });
    b!(env, "modulo", |a| match (a.first(), a.get(1)) {
        (Some(Value::Int(x)), Some(Value::Int(y))) if *y != 0 => Ok(Value::Int(x.rem_euclid(*y))),
        _ => Err("modulo: expected two non-zero integers".to_string()),
    });
    b!(env, "remainder", |a| match (a.first(), a.get(1)) {
        (Some(Value::Int(x)), Some(Value::Int(y))) if *y != 0 => Ok(Value::Int(x % y)),
        _ => Err("remainder: expected two non-zero integers".to_string()),
    });
    b!(env, "abs", |a| match a.first() {
        Some(Value::Int(i)) => Ok(Value::Int(i.abs())),
        Some(Value::Float(x)) => Ok(Value::Float(x.abs())),
        _ => Err("abs: expected a number".to_string()),
    });
    b!(env, "min", |a| num_fold(a, 0, 0.0, std::cmp::min, f64::min).or(Err("min: bad args".to_string())));
    b!(env, "max", |a| num_fold(a, 0, 0.0, std::cmp::max, f64::max).or(Err("max: bad args".to_string())));

    b!(env, "=", |a| cmp_chain(a, |x, y| x == y));
    b!(env, "<", |a| cmp_chain(a, |x, y| x < y));
    b!(env, ">", |a| cmp_chain(a, |x, y| x > y));
    b!(env, "<=", |a| cmp_chain(a, |x, y| x <= y));
    b!(env, ">=", |a| cmp_chain(a, |x, y| x >= y));

    b!(env, "not", |a| Ok(Value::Bool(!a.first().map(|v| v.truthy()).unwrap_or(false))));
    b!(env, "eq?", |a| Ok(Value::Bool(a.len() == 2 && equal(&a[0], &a[1]))));
    b!(env, "equal?", |a| Ok(Value::Bool(a.len() == 2 && equal(&a[0], &a[1]))));

    b!(env, "cons", |a| match (a.first(), a.get(1)) {
        (Some(x), Some(y)) => Ok(Value::Pair(Rc::new((x.clone(), y.clone())))),
        _ => Err("cons: expected 2 args".to_string()),
    });
    b!(env, "car", |a| match a.first() {
        Some(Value::Pair(p)) => Ok(p.0.clone()),
        _ => Err("car: expected a pair".to_string()),
    });
    b!(env, "cdr", |a| match a.first() {
        Some(Value::Pair(p)) => Ok(p.1.clone()),
        _ => Err("cdr: expected a pair".to_string()),
    });
    b!(env, "list", |a| Ok(list_from(a.to_vec())));
    b!(env, "length", |a| Ok(Value::Int(list_to_vec(a.first().unwrap_or(&Value::Nil))? .len() as i64)));
    b!(env, "reverse", |a| {
        let mut v = list_to_vec(a.first().unwrap_or(&Value::Nil))?;
        v.reverse();
        Ok(list_from(v))
    });
    b!(env, "append", |a| {
        let mut out = Vec::new();
        for l in a {
            out.extend(list_to_vec(l)?);
        }
        Ok(list_from(out))
    });
    b!(env, "list-ref", |a| match (a.first(), a.get(1)) {
        (Some(l), Some(Value::Int(i))) => {
            let v = list_to_vec(l)?;
            v.get(*i as usize).cloned().ok_or_else(|| "list-ref: index out of range".to_string())
        }
        _ => Err("list-ref: expected (list index)".to_string()),
    });

    b!(env, "null?", |a| Ok(Value::Bool(matches!(a.first(), Some(Value::Nil)))));
    b!(env, "pair?", |a| Ok(Value::Bool(matches!(a.first(), Some(Value::Pair(_))))));
    b!(env, "list?", |a| Ok(Value::Bool(a.first().map(|v| list_to_vec(v).is_ok()).unwrap_or(false))));
    b!(env, "number?", |a| Ok(Value::Bool(matches!(a.first(), Some(Value::Int(_)) | Some(Value::Float(_))))));
    b!(env, "integer?", |a| Ok(Value::Bool(matches!(a.first(), Some(Value::Int(_))))));
    b!(env, "symbol?", |a| Ok(Value::Bool(matches!(a.first(), Some(Value::Sym(_))))));
    b!(env, "string?", |a| Ok(Value::Bool(matches!(a.first(), Some(Value::Str(_))))));
    b!(env, "boolean?", |a| Ok(Value::Bool(matches!(a.first(), Some(Value::Bool(_))))));
    b!(env, "procedure?", |a| Ok(Value::Bool(matches!(a.first(), Some(Value::Builtin(..)) | Some(Value::Lambda(_))))));
    b!(env, "zero?", |a| Ok(Value::Bool(matches!(a.first(), Some(Value::Int(0))) || matches!(a.first(), Some(Value::Float(x)) if *x == 0.0))));

    b!(env, "string-length", |a| match a.first() {
        Some(Value::Str(s)) => Ok(Value::Int(s.chars().count() as i64)),
        _ => Err("string-length: expected a string".to_string()),
    });
    b!(env, "string-append", |a| {
        let mut s = String::new();
        for v in a {
            match v {
                Value::Str(x) => s.push_str(x),
                _ => return Err("string-append: expected strings".to_string()),
            }
        }
        Ok(Value::Str(Rc::new(s)))
    });
    b!(env, "number->string", |a| Ok(Value::Str(Rc::new(format!("{}", a.first().unwrap_or(&Value::Nil))))));

    b!(env, "map", |a| {
        let proc = a.first().ok_or("map: missing procedure")?;
        let list = list_to_vec(a.get(1).unwrap_or(&Value::Nil))?;
        let mut out = Vec::with_capacity(list.len());
        for item in &list {
            out.push(apply(proc, std::slice::from_ref(item))?);
        }
        Ok(list_from(out))
    });
    b!(env, "for-each", |a| {
        let proc = a.first().ok_or("for-each: missing procedure")?;
        let list = list_to_vec(a.get(1).unwrap_or(&Value::Nil))?;
        for item in &list {
            apply(proc, std::slice::from_ref(item))?;
        }
        Ok(Value::Unspecified)
    });
    b!(env, "apply", |a| {
        let proc = a.first().ok_or("apply: missing procedure")?;
        let list = list_to_vec(a.last().unwrap_or(&Value::Nil))?;
        let mut argv = a[1..a.len().saturating_sub(1)].to_vec();
        argv.extend(list);
        apply(proc, &argv)
    });

    b!(env, "display", |a| {
        if let Some(v) = a.first() {
            emit(&display_str(v));
        }
        Ok(Value::Unspecified)
    });
    b!(env, "newline", |_| {
        emit("\n");
        Ok(Value::Unspecified)
    });

    env
}

/// Evaluate `src` (which may contain several forms) in `env`, returning the value
/// of the last form plus anything it printed via `display`/`newline`.
pub fn run(src: &str, env: &Env) -> Result<(Value, String), String> {
    let forms = parse(src)?;
    let mut result = Value::Unspecified;
    for form in &forms {
        result = eval(form, env)?;
    }
    Ok((result, take_output()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(src: &str) -> String {
        let env = global_env();
        match run(src, &env) {
            Ok((v, _out)) => format!("{v}"),
            Err(e) => format!("error: {e}"),
        }
    }

    #[test]
    fn arithmetic_is_exact_for_ints_and_floats() {
        assert_eq!(ev("(+ 1 2 3)"), "6");
        assert_eq!(ev("(* 2 3 4)"), "24");
        assert_eq!(ev("(- 10 3 2)"), "5");
        assert_eq!(ev("(/ 12 3 2)"), "2"); // exact integer division
        assert_eq!(ev("(/ 1 2)"), "0.5"); // inexact → float
        assert_eq!(ev("(+ 1.5 2)"), "3.5");
        assert_eq!(ev("(modulo 17 5)"), "2");
        assert_eq!(ev("(abs -7)"), "7");
    }

    #[test]
    fn comparison_and_booleans() {
        assert_eq!(ev("(< 1 2 3)"), "#t");
        assert_eq!(ev("(< 1 3 2)"), "#f");
        assert_eq!(ev("(= 2 2 2)"), "#t");
        assert_eq!(ev("(and #t (> 3 1))"), "#t");
        assert_eq!(ev("(or #f #f 5)"), "5");
        assert_eq!(ev("(not #f)"), "#t");
    }

    #[test]
    fn lists_and_pairs() {
        assert_eq!(ev("(list 1 2 3)"), "(1 2 3)");
        assert_eq!(ev("(cons 1 (list 2 3))"), "(1 2 3)");
        assert_eq!(ev("(car (list 1 2 3))"), "1");
        assert_eq!(ev("(cdr (list 1 2 3))"), "(2 3)");
        assert_eq!(ev("(length (list 1 2 3 4))"), "4");
        assert_eq!(ev("(reverse (list 1 2 3))"), "(3 2 1)");
        assert_eq!(ev("(append (list 1 2) (list 3 4))"), "(1 2 3 4)");
        assert_eq!(ev("(null? (list))"), "#t");
        assert_eq!(ev("'(1 2 3)"), "(1 2 3)"); // quote
    }

    #[test]
    fn define_lambda_closures_and_recursion() {
        let env = global_env();
        run("(define (square x) (* x x))", &env).unwrap();
        assert_eq!(format!("{}", run("(square 9)", &env).unwrap().0), "81");

        // A closure that captures its environment.
        run("(define (adder n) (lambda (x) (+ x n)))", &env).unwrap();
        run("(define add5 (adder 5))", &env).unwrap();
        assert_eq!(format!("{}", run("(add5 10)", &env).unwrap().0), "15");

        // Recursion: factorial + fibonacci.
        run("(define (fact n) (if (= n 0) 1 (* n (fact (- n 1)))))", &env).unwrap();
        assert_eq!(format!("{}", run("(fact 10)", &env).unwrap().0), "3628800");
        run("(define (fib n) (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2)))))", &env).unwrap();
        assert_eq!(format!("{}", run("(fib 15)", &env).unwrap().0), "610");
    }

    #[test]
    fn let_cond_map_and_higher_order() {
        assert_eq!(ev("(let ((a 2) (b 3)) (+ a b))"), "5");
        assert_eq!(ev("(let* ((a 2) (b (* a 3))) b)"), "6");
        assert_eq!(ev("(cond ((= 1 2) 'no) ((= 1 1) 'yes) (else 'other))"), "yes");
        assert_eq!(ev("(map (lambda (x) (* x x)) (list 1 2 3 4))"), "(1 4 9 16)");
        assert_eq!(ev("(apply + (list 1 2 3 4))"), "10");
    }

    #[test]
    fn strings_set_and_display_output() {
        assert_eq!(ev("(string-append \"foo\" \"bar\")"), "\"foobar\"");
        assert_eq!(ev("(string-length \"hello\")"), "5");
        let env = global_env();
        run("(define x 1)", &env).unwrap();
        run("(set! x 42)", &env).unwrap();
        assert_eq!(format!("{}", run("x", &env).unwrap().0), "42");
        // display writes to the output buffer (no quotes for strings).
        let (_v, out) = run("(display \"hi\") (newline) (display (+ 2 3))", &env).unwrap();
        assert_eq!(out, "hi\n5");
    }

    #[test]
    fn errors_are_reported_not_panicked() {
        assert_eq!(ev("(+ 1 'a)"), "error: expected a number, got a");
        assert_eq!(ev("(car 5)"), "error: car: expected a pair");
        assert_eq!(ev("undefined-var"), "error: unbound variable: undefined-var");
        assert_eq!(ev("(/ 1 0)"), "error: /: division by zero");
    }
}
