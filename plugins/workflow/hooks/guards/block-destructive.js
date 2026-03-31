#!/usr/bin/env bun
// @bun

// guards/block-destructive.ts
import { readFileSync, realpathSync, unlinkSync } from "fs";
import { createHash } from "crypto";
import { homedir } from "os";
import { resolve as pathResolve } from "path";

// node_modules/unbash/dist/chars.js
var CH_TAB = 9;
var CH_NL = 10;
var CH_SPACE = 32;
var CH_BANG = 33;
var CH_DQUOTE = 34;
var CH_HASH = 35;
var CH_DOLLAR = 36;
var CH_PERCENT = 37;
var CH_AMP = 38;
var CH_SQUOTE = 39;
var CH_LPAREN = 40;
var CH_RPAREN = 41;
var CH_STAR = 42;
var CH_PLUS = 43;
var CH_COMMA = 44;
var CH_DASH = 45;
var CH_SLASH = 47;
var CH_0 = 48;
var CH_9 = 57;
var CH_COLON = 58;
var CH_SEMI = 59;
var CH_LT = 60;
var CH_EQ = 61;
var CH_GT = 62;
var CH_QUESTION = 63;
var CH_AT = 64;
var CH_A = 65;
var CH_Z = 90;
var CH_LBRACKET = 91;
var CH_BACKSLASH = 92;
var CH_RBRACKET = 93;
var CH_CARET = 94;
var CH_UNDERSCORE = 95;
var CH_BACKTICK = 96;
var CH_a = 97;
var CH_z = 122;
var CH_LBRACE = 123;
var CH_PIPE = 124;
var CH_RBRACE = 125;
var CH_TILDE = 126;

// node_modules/unbash/dist/arithmetic.js
function opPrec(op) {
  switch (op) {
    case ",":
      return 1;
    case "=":
    case "+=":
    case "-=":
    case "*=":
    case "/=":
    case "%=":
    case "<<=":
    case ">>=":
    case "&=":
    case "|=":
    case "^=":
      return 2;
    case "||":
      return 4;
    case "&&":
      return 5;
    case "|":
      return 6;
    case "^":
      return 7;
    case "&":
      return 8;
    case "==":
    case "!=":
      return 9;
    case "<":
    case "<=":
    case ">":
    case ">=":
      return 10;
    case "<<":
    case ">>":
      return 11;
    case "+":
    case "-":
      return 12;
    case "*":
    case "/":
    case "%":
      return 13;
    case "**":
      return 14;
    default:
      return -1;
  }
}
function opRightAssoc(op) {
  switch (op) {
    case "=":
    case "+=":
    case "-=":
    case "*=":
    case "/=":
    case "%=":
    case "<<=":
    case ">>=":
    case "&=":
    case "|=":
    case "^=":
    case "**":
      return true;
    default:
      return false;
  }
}
function parseArithmeticExpression(src, offset = 0) {
  let pos = 0;
  const len = src.length;
  function skipWS() {
    while (pos < len) {
      const c = src.charCodeAt(pos);
      if (c === CH_SPACE || c === CH_TAB || c === CH_NL)
        pos++;
      else
        break;
    }
  }
  function tryReadBinOp() {
    if (pos >= len)
      return null;
    const c = src.charCodeAt(pos);
    const nc = pos + 1 < len ? src.charCodeAt(pos + 1) : 0;
    const nnc = pos + 2 < len ? src.charCodeAt(pos + 2) : 0;
    switch (c) {
      case CH_COMMA:
        pos++;
        return ",";
      case CH_EQ:
        if (nc === CH_EQ) {
          pos += 2;
          return "==";
        }
        pos++;
        return "=";
      case CH_BANG:
        if (nc === CH_EQ) {
          pos += 2;
          return "!=";
        }
        return null;
      case CH_LT:
        if (nc === CH_LT) {
          if (nnc === CH_EQ) {
            pos += 3;
            return "<<=";
          }
          pos += 2;
          return "<<";
        }
        if (nc === CH_EQ) {
          pos += 2;
          return "<=";
        }
        pos++;
        return "<";
      case CH_GT:
        if (nc === CH_GT) {
          if (nnc === CH_EQ) {
            pos += 3;
            return ">>=";
          }
          pos += 2;
          return ">>";
        }
        if (nc === CH_EQ) {
          pos += 2;
          return ">=";
        }
        pos++;
        return ">";
      case CH_PLUS:
        if (nc === CH_EQ) {
          pos += 2;
          return "+=";
        }
        if (nc === CH_PLUS)
          return null;
        pos++;
        return "+";
      case CH_DASH:
        if (nc === CH_EQ) {
          pos += 2;
          return "-=";
        }
        if (nc === CH_DASH)
          return null;
        pos++;
        return "-";
      case CH_STAR:
        if (nc === CH_STAR) {
          pos += 2;
          return "**";
        }
        if (nc === CH_EQ) {
          pos += 2;
          return "*=";
        }
        pos++;
        return "*";
      case CH_SLASH:
        if (nc === CH_EQ) {
          pos += 2;
          return "/=";
        }
        pos++;
        return "/";
      case CH_PERCENT:
        if (nc === CH_EQ) {
          pos += 2;
          return "%=";
        }
        pos++;
        return "%";
      case CH_PIPE:
        if (nc === CH_PIPE) {
          pos += 2;
          return "||";
        }
        if (nc === CH_EQ) {
          pos += 2;
          return "|=";
        }
        pos++;
        return "|";
      case CH_AMP:
        if (nc === CH_AMP) {
          pos += 2;
          return "&&";
        }
        if (nc === CH_EQ) {
          pos += 2;
          return "&=";
        }
        pos++;
        return "&";
      case CH_CARET:
        if (nc === CH_EQ) {
          pos += 2;
          return "^=";
        }
        pos++;
        return "^";
      case CH_QUESTION:
        pos++;
        return "?";
      default:
        return null;
    }
  }
  function parseBinExpr(minPrec) {
    let left = parseUnaryExpr();
    while (true) {
      skipWS();
      if (pos >= len)
        break;
      const saved = pos;
      const op = tryReadBinOp();
      if (!op)
        break;
      if (op === "?") {
        if (3 < minPrec) {
          pos = saved;
          break;
        }
        const consequent = parseBinExpr(1);
        skipWS();
        if (pos < len && src.charCodeAt(pos) === CH_COLON)
          pos++;
        const alternate = parseBinExpr(3);
        left = { type: "ArithmeticTernary", pos: left.pos, end: alternate.end, test: left, consequent, alternate };
        continue;
      }
      const prec = opPrec(op);
      if (prec < minPrec) {
        pos = saved;
        break;
      }
      const nextPrec = opRightAssoc(op) ? prec : prec + 1;
      const right = parseBinExpr(nextPrec);
      left = { type: "ArithmeticBinary", pos: left.pos, end: right.end, operator: op, left, right };
    }
    return left;
  }
  function parseUnaryExpr() {
    skipWS();
    if (pos >= len)
      return { type: "ArithmeticWord", pos: pos + offset, end: pos + offset, value: "" };
    const start = pos;
    const c = src.charCodeAt(pos);
    const nc = pos + 1 < len ? src.charCodeAt(pos + 1) : 0;
    if (c === CH_PLUS && nc === CH_PLUS) {
      pos += 2;
      const operand = parseUnaryExpr();
      return { type: "ArithmeticUnary", pos: start + offset, end: operand.end, operator: "++", operand, prefix: true };
    }
    if (c === CH_DASH && nc === CH_DASH) {
      pos += 2;
      const operand = parseUnaryExpr();
      return { type: "ArithmeticUnary", pos: start + offset, end: operand.end, operator: "--", operand, prefix: true };
    }
    if (c === CH_BANG) {
      pos++;
      const operand = parseUnaryExpr();
      return { type: "ArithmeticUnary", pos: start + offset, end: operand.end, operator: "!", operand, prefix: true };
    }
    if (c === CH_TILDE) {
      pos++;
      const operand = parseUnaryExpr();
      return { type: "ArithmeticUnary", pos: start + offset, end: operand.end, operator: "~", operand, prefix: true };
    }
    if (c === CH_PLUS && nc !== CH_PLUS && nc !== CH_EQ) {
      pos++;
      const operand = parseUnaryExpr();
      return { type: "ArithmeticUnary", pos: start + offset, end: operand.end, operator: "+", operand, prefix: true };
    }
    if (c === CH_DASH && nc !== CH_DASH && nc !== CH_EQ) {
      pos++;
      const operand = parseUnaryExpr();
      return { type: "ArithmeticUnary", pos: start + offset, end: operand.end, operator: "-", operand, prefix: true };
    }
    return parsePostfixExpr();
  }
  function parsePostfixExpr() {
    const operand = parseAtom();
    skipWS();
    if (pos + 1 < len) {
      const c = src.charCodeAt(pos);
      const nc = src.charCodeAt(pos + 1);
      if (c === CH_PLUS && nc === CH_PLUS) {
        pos += 2;
        return { type: "ArithmeticUnary", pos: operand.pos, end: pos + offset, operator: "++", operand, prefix: false };
      }
      if (c === CH_DASH && nc === CH_DASH) {
        pos += 2;
        return { type: "ArithmeticUnary", pos: operand.pos, end: pos + offset, operator: "--", operand, prefix: false };
      }
    }
    return operand;
  }
  function parseAtom() {
    skipWS();
    if (pos >= len)
      return { type: "ArithmeticWord", pos: pos + offset, end: pos + offset, value: "" };
    const c = src.charCodeAt(pos);
    if (c === CH_LPAREN) {
      const start = pos;
      pos++;
      const expr = parseBinExpr(0);
      skipWS();
      if (pos < len && src.charCodeAt(pos) === CH_RPAREN)
        pos++;
      return { type: "ArithmeticGroup", pos: start + offset, end: pos + offset, expression: expr };
    }
    if (c === CH_DOLLAR) {
      return readDollarAtom();
    }
    return readWordAtom();
  }
  function readDollarAtom() {
    const start = pos;
    pos++;
    if (pos >= len)
      return { type: "ArithmeticWord", pos: start + offset, end: pos + offset, value: "$" };
    const c = src.charCodeAt(pos);
    if (c === CH_LPAREN) {
      if (pos + 1 < len && src.charCodeAt(pos + 1) === CH_LPAREN) {
        pos += 2;
        let depth = 1;
        while (pos < len && depth > 0) {
          if (src.charCodeAt(pos) === CH_LPAREN && pos + 1 < len && src.charCodeAt(pos + 1) === CH_LPAREN) {
            depth++;
            pos += 2;
          } else if (src.charCodeAt(pos) === CH_RPAREN && pos + 1 < len && src.charCodeAt(pos + 1) === CH_RPAREN) {
            depth--;
            if (depth > 0)
              pos += 2;
            else
              pos += 2;
          } else
            pos++;
        }
      } else {
        pos++;
        let depth = 1;
        while (pos < len && depth > 0) {
          const ch = src.charCodeAt(pos);
          if (ch === CH_LPAREN)
            depth++;
          else if (ch === CH_RPAREN)
            depth--;
          pos++;
        }
      }
    } else if (c === CH_LBRACE) {
      pos++;
      let depth = 1;
      while (pos < len && depth > 0) {
        const ch = src.charCodeAt(pos);
        if (ch === CH_LBRACE)
          depth++;
        else if (ch === CH_RBRACE)
          depth--;
        pos++;
      }
    } else {
      while (pos < len) {
        const ch = src.charCodeAt(pos);
        if (ch >= CH_a && ch <= CH_z || ch >= CH_A && ch <= CH_Z || ch >= CH_0 && ch <= CH_9 || ch === CH_UNDERSCORE)
          pos++;
        else
          break;
      }
    }
    return { type: "ArithmeticWord", pos: start + offset, end: pos + offset, value: src.slice(start, pos) };
  }
  function readWordAtom() {
    const start = pos;
    while (pos < len) {
      const c = src.charCodeAt(pos);
      if (c >= CH_0 && c <= CH_9 || c >= CH_A && c <= CH_Z || c >= CH_a && c <= CH_z || c === CH_UNDERSCORE || c === 35) {
        pos++;
      } else
        break;
    }
    if (pos > start && pos < len && src.charCodeAt(pos) === CH_LBRACKET) {
      pos++;
      let depth = 1;
      while (pos < len && depth > 0) {
        const c = src.charCodeAt(pos);
        if (c === CH_LBRACKET)
          depth++;
        else if (c === CH_RBRACKET)
          depth--;
        pos++;
      }
    }
    if (pos === start) {
      pos++;
      return { type: "ArithmeticWord", pos: start + offset, end: pos + offset, value: src.slice(start, pos) };
    }
    return { type: "ArithmeticWord", pos: start + offset, end: pos + offset, value: src.slice(start, pos) };
  }
  skipWS();
  if (pos >= len)
    return null;
  const result = parseBinExpr(0);
  skipWS();
  return result;
}

// node_modules/unbash/dist/word.js
function dequoteValue(parts) {
  let s = "";
  for (const c of parts)
    s += c.type === "Literal" ? c.value : c.text;
  return s;
}

class WordImpl {
  static _resolve;
  text;
  pos;
  end;
  #source;
  #parts;
  #value = null;
  constructor(text, pos, end, source) {
    this.text = text;
    this.pos = pos;
    this.end = end;
    this.#source = source ?? "";
    this.#parts = source !== undefined ? null : undefined;
  }
  get value() {
    if (this.#value === null) {
      const parts = this.parts;
      if (!parts) {
        this.#value = this.text;
      } else {
        let s = "";
        for (const p of parts) {
          switch (p.type) {
            case "Literal":
            case "SingleQuoted":
            case "AnsiCQuoted":
              s += p.value;
              break;
            case "DoubleQuoted":
            case "LocaleString":
              s += dequoteValue(p.parts);
              break;
            default:
              s += p.text;
              break;
          }
        }
        this.#value = s;
      }
    }
    return this.#value;
  }
  get parts() {
    if (this.#parts === null) {
      this.#parts = WordImpl._resolve(this.#source, this) ?? undefined;
    }
    return this.#parts;
  }
  set parts(v) {
    this.#parts = v ?? undefined;
  }
  toJSON() {
    return { text: this.text, pos: this.pos, end: this.end, parts: this.parts, value: this.value };
  }
}

// node_modules/unbash/dist/lexer.js
var Token = {
  Word: 0,
  Assignment: 1,
  Semi: 2,
  Newline: 3,
  Pipe: 4,
  And: 5,
  Or: 6,
  Amp: 7,
  LParen: 8,
  RParen: 9,
  LBrace: 10,
  RBrace: 11,
  Bang: 12,
  If: 13,
  Then: 14,
  Else: 15,
  Elif: 16,
  Fi: 17,
  Do: 18,
  Done: 19,
  For: 20,
  While: 21,
  Until: 22,
  In: 23,
  Case: 24,
  Esac: 25,
  Function: 26,
  DoubleSemi: 27,
  SemiAmp: 28,
  DoubleSemiAmp: 29,
  Select: 30,
  DblLBracket: 31,
  DblRBracket: 32,
  EOF: 33,
  ArithCmd: 34,
  Coproc: 35,
  Redirect: 36
};

class TokenValue {
  token = Token.EOF;
  value = "";
  pos = 0;
  end = 0;
  fileDescriptor = undefined;
  variableName = undefined;
  content = undefined;
  targetPos = 0;
  targetEnd = 0;
  reset() {
    this.token = Token.EOF;
    this.value = "";
    this.pos = 0;
    this.end = 0;
    this.fileDescriptor = undefined;
    this.variableName = undefined;
    this.content = undefined;
    this.targetPos = 0;
    this.targetEnd = 0;
  }
  copyFrom(other) {
    this.token = other.token;
    this.value = other.value;
    this.pos = other.pos;
    this.end = other.end;
    this.fileDescriptor = other.fileDescriptor;
    this.variableName = other.variableName;
    this.content = other.content;
    this.targetPos = other.targetPos;
    this.targetEnd = other.targetEnd;
  }
}
var RESERVED_WORDS = {
  if: Token.If,
  then: Token.Then,
  else: Token.Else,
  elif: Token.Elif,
  fi: Token.Fi,
  do: Token.Do,
  done: Token.Done,
  for: Token.For,
  while: Token.While,
  until: Token.Until,
  in: Token.In,
  case: Token.Case,
  esac: Token.Esac,
  function: Token.Function,
  select: Token.Select,
  coproc: Token.Coproc,
  "!": Token.Bang,
  "{": Token.LBrace,
  "}": Token.RBrace
};
var charType = new Uint8Array(128);
charType[CH_PIPE] = 1;
charType[CH_AMP] = 1;
charType[CH_SEMI] = 1;
charType[CH_LPAREN] = 1;
charType[CH_RPAREN] = 1;
charType[CH_LT] = 1;
charType[CH_GT] = 1;
charType[CH_SPACE] = 1;
charType[CH_TAB] = 1;
charType[CH_NL] = 1;
charType[CH_BACKSLASH] = 2;
charType[CH_SQUOTE] = 2;
charType[CH_DQUOTE] = 2;
charType[CH_DOLLAR] = 2;
charType[CH_BACKTICK] = 2;
charType[CH_LBRACE] = 2;
function findUnnested(s, target) {
  let depth = 0;
  for (let i = 0;i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === CH_BACKSLASH) {
      i++;
      continue;
    }
    if (c === CH_LBRACE) {
      depth++;
      continue;
    }
    if (c === CH_RBRACE) {
      if (depth > 0)
        depth--;
      continue;
    }
    if (c === CH_SQUOTE) {
      i++;
      while (i < s.length && s.charCodeAt(i) !== CH_SQUOTE)
        i++;
      continue;
    }
    if (c === CH_DQUOTE) {
      i++;
      while (i < s.length && s.charCodeAt(i) !== CH_DQUOTE) {
        if (s.charCodeAt(i) === CH_BACKSLASH)
          i++;
        i++;
      }
      continue;
    }
    if (c === target && depth === 0)
      return i;
  }
  return -1;
}
var isIdChar = new Uint8Array(128);
for (let i = CH_a;i <= CH_z; i++)
  isIdChar[i] = 3;
for (let i = CH_A;i <= CH_Z; i++)
  isIdChar[i] = 3;
for (let i = CH_0;i <= CH_9; i++)
  isIdChar[i] = 2;
isIdChar[CH_UNDERSCORE] = 3;
var extglobPrefix = new Uint8Array(128);
extglobPrefix[CH_QUESTION] = 1;
extglobPrefix[CH_AT] = 1;
extglobPrefix[CH_STAR] = 1;
extglobPrefix[CH_PLUS] = 1;
extglobPrefix[CH_BANG] = 1;
extglobPrefix[CH_EQ] = 1;
var extglobOp = {
  [CH_QUESTION]: "?",
  [CH_AT]: "@",
  [CH_STAR]: "*",
  [CH_PLUS]: "+",
  [CH_BANG]: "!"
};
function isDQChild(p) {
  const t = p.type;
  return t === "Literal" || t === "SimpleExpansion" || t === "ParameterExpansion" || t === "CommandExpansion" || t === "ArithmeticExpansion";
}
function isAllDigits(text) {
  for (let i = 0;i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < CH_0 || c > CH_9)
      return false;
  }
  return text.length > 0;
}
function isAssignmentWord(text) {
  const eqIdx = text.indexOf("=");
  if (eqIdx <= 0)
    return false;
  let c = text.charCodeAt(0);
  if (c >= 128 || !(isIdChar[c] & 1))
    return false;
  let i = 1;
  for (;i < eqIdx; i++) {
    c = text.charCodeAt(i);
    if (c >= 128 || !(isIdChar[c] & 2))
      break;
  }
  if (i === eqIdx)
    return true;
  if (c === CH_PLUS && i + 1 === eqIdx)
    return true;
  if (c === CH_LBRACKET) {
    const rbIdx = text.indexOf("]", i + 1);
    if (rbIdx > i && (rbIdx + 1 === eqIdx || text.charCodeAt(rbIdx + 1) === CH_PLUS && rbIdx + 2 === eqIdx))
      return true;
  }
  return false;
}
function setToken(out, token, value, pos = 0, end = 0) {
  out.token = token;
  out.value = value;
  out.pos = pos;
  out.end = end;
  out.fileDescriptor = undefined;
  out.variableName = undefined;
  out.content = undefined;
}
var LexContext = {
  Normal: 0,
  CommandStart: 1,
  TestMode: 2
};
function scanBraceExpansion(src, pos, len) {
  const nextCh = pos + 1 < len ? src.charCodeAt(pos + 1) : 0;
  if (nextCh <= CH_SPACE || nextCh === CH_RBRACE)
    return -1;
  let depth = 1;
  let hasSep = false;
  let scanPos = pos + 1;
  while (scanPos < len && depth > 0) {
    const bc = src.charCodeAt(scanPos);
    if (bc === CH_LBRACE)
      depth++;
    else if (bc === CH_RBRACE) {
      if (--depth === 0)
        break;
    } else if (bc <= CH_SPACE || bc === CH_SEMI || bc === CH_PIPE || bc === CH_AMP)
      return -1;
    else if (depth === 1 && (bc === 44 || bc === 46 && scanPos + 1 < len && src.charCodeAt(scanPos + 1) === 46))
      hasSep = true;
    if (bc === CH_BACKSLASH)
      scanPos++;
    scanPos++;
  }
  if (depth === 0 && hasSep)
    return scanPos + 1;
  return -1;
}

class Lexer {
  src;
  pos;
  current;
  nextState;
  hasPeek;
  pendingHereDocs;
  collectedExpansions;
  _errors = null;
  _buildParts = false;
  constructor(src) {
    this.src = src;
    this.pos = 0;
    this.current = new TokenValue;
    this.nextState = new TokenValue;
    this.hasPeek = false;
    this.pendingHereDocs = [];
    this.collectedExpansions = [];
    if (src.charCodeAt(0) === CH_HASH && src.charCodeAt(1) === CH_BANG) {
      const nl = src.indexOf(`
`);
      this.pos = nl === -1 ? src.length : nl + 1;
    }
  }
  get errors() {
    return this._errors ?? (this._errors = []);
  }
  getCollectedExpansions() {
    return this.collectedExpansions;
  }
  getPos() {
    return this.pos;
  }
  buildWordParts(startPos) {
    this._buildParts = true;
    this.pos = startPos;
    const ch = this.src.charCodeAt(startPos);
    if ((ch === 60 || ch === 62) && startPos + 1 < this.src.length && this.src.charCodeAt(startPos + 1) === 40) {
      this.pos = startPos + 2;
      const inner = this.extractBalanced();
      const text = this.src.slice(startPos, this.pos);
      const part = {
        type: "ProcessSubstitution",
        text,
        operator: ch === 60 ? "<" : ">",
        script: undefined,
        inner: inner ?? undefined
      };
      const exp = { inner: inner ?? undefined, _part: part };
      this.collectedExpansions.push(exp);
      if (this.pos < this.src.length) {
        this.readWordText();
        if (this._wordParts) {
          this._wordParts.unshift(part);
        } else {
          this._wordParts = [part];
        }
      } else {
        this._wordParts = [part];
      }
    } else {
      this.readWordText();
    }
    return this._wordParts;
  }
  buildHereDocParts(bodyPos, bodyEnd) {
    this._buildParts = true;
    const src = this.src;
    const parts = [];
    let litBuf = "";
    let litStart = bodyPos;
    let i = bodyPos;
    const flushLit = () => {
      if (litBuf) {
        parts.push({ type: "Literal", value: litBuf, text: src.slice(litStart, i) });
        litBuf = "";
      }
    };
    while (i < bodyEnd) {
      const ch = src.charCodeAt(i);
      if (ch === 92) {
        if (i + 1 < bodyEnd) {
          const nc = src.charCodeAt(i + 1);
          if (nc === 36 || nc === 96 || nc === 92) {
            litBuf += String.fromCharCode(nc);
            i += 2;
            continue;
          }
        }
        litBuf += "\\";
        i++;
        continue;
      }
      if (ch === 36) {
        flushLit();
        litStart = i;
        this.pos = i;
        this.readDollar();
        if (this._resultPart) {
          parts.push(this._resultPart);
          litStart = this.pos;
        } else {
          litBuf += src.slice(i, this.pos);
        }
        i = this.pos;
        continue;
      }
      if (ch === 96) {
        flushLit();
        litStart = i;
        this.pos = i;
        this.readBacktickExpansion();
        if (this._resultPart) {
          parts.push(this._resultPart);
          litStart = this.pos;
        } else {
          litBuf += src.slice(i, this.pos);
        }
        i = this.pos;
        continue;
      }
      litBuf += src[i];
      i++;
    }
    flushLit();
    return parts.length > 1 || parts.length === 1 && parts[0].type !== "Literal" ? parts : null;
  }
  registerHereDocTarget(target) {
    for (const hd of this.pendingHereDocs) {
      if (!hd.target) {
        hd.target = target;
        return;
      }
    }
  }
  readTestRegexWord() {
    this.hasPeek = false;
    const chars = [CH_LPAREN, CH_RPAREN, CH_PIPE, CH_LT, CH_GT];
    const saved = chars.map((c) => charType[c]);
    for (const c of chars)
      charType[c] = 0;
    try {
      this.skipSpacesAndTabs();
      this.readWord(this.current, LexContext.Normal, this.pos);
      return this.current;
    } finally {
      for (let i = 0;i < chars.length; i++)
        charType[chars[i]] = saved[i];
    }
  }
  readCStyleForExprs() {
    this.hasPeek = false;
    const src = this.src;
    const len = src.length;
    while (this.pos < len && (src.charCodeAt(this.pos) === CH_SPACE || src.charCodeAt(this.pos) === CH_TAB))
      this.pos++;
    if (this.pos < len && src.charCodeAt(this.pos) === CH_LPAREN)
      this.pos++;
    const starts = [this.pos, 0, 0];
    const parts = ["", "", "", 0, 0, 0];
    let partIdx = 0;
    let depth = 1;
    let partStart = this.pos;
    while (this.pos < len && depth > 0) {
      const c = src.charCodeAt(this.pos);
      if (c === CH_LPAREN) {
        depth++;
        this.pos++;
      } else if (c === CH_RPAREN) {
        depth--;
        if (depth === 0) {
          const raw = src.slice(partStart, this.pos);
          parts[partIdx] = raw.trim();
          parts[3 + partIdx] = starts[partIdx] + raw.length - raw.trimStart().length;
          this.pos++;
          while (this.pos < len && (src.charCodeAt(this.pos) === CH_SPACE || src.charCodeAt(this.pos) === CH_TAB))
            this.pos++;
          if (this.pos < len && src.charCodeAt(this.pos) === CH_RPAREN)
            this.pos++;
          break;
        }
        this.pos++;
      } else if (c === CH_SEMI && depth === 1) {
        const raw = src.slice(partStart, this.pos);
        parts[partIdx] = raw.trim();
        parts[3 + partIdx] = starts[partIdx] + raw.length - raw.trimStart().length;
        if (partIdx < 2)
          partIdx++;
        this.pos++;
        partStart = this.pos;
        starts[partIdx] = partStart;
      } else if (c === CH_SQUOTE) {
        this.pos++;
        this.skipSQ();
      } else if (c === CH_DQUOTE) {
        this.pos++;
        this.skipDQ();
      } else {
        this.pos++;
      }
    }
    return parts;
  }
  peek(ctx = LexContext.Normal) {
    if (!this.hasPeek) {
      this.readNext(this.nextState, ctx);
      this.hasPeek = true;
    }
    return this.nextState;
  }
  next(ctx = LexContext.Normal) {
    if (this.hasPeek) {
      this.hasPeek = false;
      const temp = this.current;
      this.current = this.nextState;
      this.nextState = temp;
      return this.current;
    }
    this.readNext(this.current, ctx);
    return this.current;
  }
  unshift(tok) {
    this.nextState.copyFrom(tok);
    this.hasPeek = true;
  }
  readNext(out, ctx) {
    const src = this.src;
    const len = src.length;
    let pos = this.pos;
    while (pos < len) {
      const ch2 = src.charCodeAt(pos);
      if (ch2 === CH_SPACE || ch2 === CH_TAB) {
        pos++;
        continue;
      }
      if (ch2 === CH_BACKSLASH && pos + 1 < len && src.charCodeAt(pos + 1) === CH_NL) {
        pos += 2;
        continue;
      }
      if (ch2 === CH_NL && ctx === LexContext.TestMode) {
        pos++;
        continue;
      }
      break;
    }
    this.pos = pos;
    if (pos >= len) {
      setToken(out, Token.EOF, "", pos, pos);
      return;
    }
    const tokenStart = pos;
    const ch = src.charCodeAt(pos);
    if (ch === CH_HASH) {
      while (this.pos < len && src.charCodeAt(this.pos) !== CH_NL)
        this.pos++;
      this.readNext(out, ctx);
      return;
    }
    if (ch === CH_NL) {
      this.pos++;
      this.consumePendingHereDocs();
      setToken(out, Token.Newline, `
`, tokenStart, this.pos);
      return;
    }
    if (ctx === LexContext.TestMode && (ch === CH_LT || ch === CH_GT)) {
      this.pos++;
      setToken(out, Token.Word, ch === CH_LT ? "<" : ">", tokenStart, this.pos);
      return;
    }
    if (this.tryReadOperator(out, ch, ctx, tokenStart))
      return;
    this.readWord(out, ctx, tokenStart);
  }
  tryReadOperator(out, ch, ctx, tokenStart) {
    const src = this.src;
    const pos = this.pos;
    const next = pos + 1 < src.length ? src.charCodeAt(pos + 1) : 0;
    switch (ch) {
      case CH_SEMI:
        if (next === CH_SEMI) {
          if (pos + 2 < src.length && src.charCodeAt(pos + 2) === CH_AMP) {
            this.pos += 3;
            setToken(out, Token.DoubleSemiAmp, ";;&", tokenStart, this.pos);
            return true;
          }
          this.pos += 2;
          setToken(out, Token.DoubleSemi, ";;", tokenStart, this.pos);
          return true;
        }
        if (next === CH_AMP) {
          this.pos += 2;
          setToken(out, Token.SemiAmp, ";&", tokenStart, this.pos);
          return true;
        }
        this.pos++;
        setToken(out, Token.Semi, ";", tokenStart, this.pos);
        return true;
      case CH_PIPE:
        if (next === CH_PIPE) {
          this.pos += 2;
          setToken(out, Token.Or, "||", tokenStart, this.pos);
          return true;
        }
        if (next === CH_AMP) {
          this.pos += 2;
          setToken(out, Token.Pipe, "|&", tokenStart, this.pos);
          return true;
        }
        this.pos++;
        setToken(out, Token.Pipe, "|", tokenStart, this.pos);
        return true;
      case CH_AMP:
        if (next === CH_AMP) {
          this.pos += 2;
          setToken(out, Token.And, "&&", tokenStart, this.pos);
          return true;
        }
        if (next === CH_GT) {
          this.pos += 2;
          const append = this.pos < src.length && src.charCodeAt(this.pos) === CH_GT;
          if (append)
            this.pos++;
          this.skipSpacesAndTabs();
          this._redirectTargetPos = this.pos;
          if (this.pos < src.length && src.charCodeAt(this.pos) !== CH_NL)
            this.readWordText();
          this.redirectToken(out, append ? "&>>" : "&>", tokenStart);
          return true;
        }
        this.pos++;
        setToken(out, Token.Amp, "&", tokenStart, this.pos);
        return true;
      case CH_LPAREN:
        if (ctx === LexContext.CommandStart && next === CH_LPAREN) {
          this.readArithmeticCommand(out, tokenStart);
          return true;
        }
        this.pos++;
        setToken(out, Token.LParen, "(", tokenStart, this.pos);
        return true;
      case CH_RPAREN:
        this.pos++;
        setToken(out, Token.RParen, ")", tokenStart, this.pos);
        return true;
      case CH_LT:
      case CH_GT:
        return this.readRedirection(out, tokenStart);
      default:
        return false;
    }
  }
  readRedirection(out, tokenStart) {
    const src = this.src;
    const ch = src.charCodeAt(this.pos);
    let op = "";
    if (ch === CH_LT) {
      this.pos++;
      const next = this.pos < src.length ? src.charCodeAt(this.pos) : 0;
      if (next === CH_LT) {
        this.pos++;
        const third = this.pos < src.length ? src.charCodeAt(this.pos) : 0;
        if (third === CH_LT) {
          this.pos++;
          this.skipSpacesAndTabs();
          this._redirectTargetPos = this.pos;
          if (this.pos < src.length && src.charCodeAt(this.pos) !== CH_NL)
            this.readWordText();
          this.redirectToken(out, "<<<", tokenStart);
          return true;
        }
        const dash = third === CH_DASH;
        if (dash)
          this.pos++;
        this.skipSpacesAndTabs();
        this.readHereDocDelimiter();
        this.pendingHereDocs.push({ delimiter: this._hereDelim, strip: dash, quoted: this._hereQuoted });
        setToken(out, Token.Redirect, dash ? "<<-" : "<<", tokenStart, this.pos);
        out.content = this._hereDelim;
        return true;
      }
      if (next === CH_LPAREN) {
        this.readProcessSubstitution(out, "<", tokenStart);
        return true;
      }
      if (next === CH_GT) {
        op = "<>";
        this.pos++;
      } else if (next === CH_AMP) {
        op = "<&";
        this.pos++;
      } else {
        op = "<";
      }
    } else if (ch === CH_GT) {
      this.pos++;
      const next = this.pos < src.length ? src.charCodeAt(this.pos) : 0;
      if (next === CH_LPAREN) {
        this.readProcessSubstitution(out, ">", tokenStart);
        return true;
      }
      if (next === CH_GT) {
        op = ">>";
        this.pos++;
      } else if (next === CH_AMP) {
        op = ">&";
        this.pos++;
      } else if (next === CH_PIPE) {
        op = ">|";
        this.pos++;
      } else {
        op = ">";
      }
    }
    this.skipSpacesAndTabs();
    if (this.pos < src.length) {
      const nc = src.charCodeAt(this.pos);
      if ((nc === CH_LT || nc === CH_GT) && this.pos + 1 < src.length && src.charCodeAt(this.pos + 1) === CH_LPAREN) {
        const psStart = this.pos;
        this.pos += 2;
        this.extractBalanced();
        const psText = src.slice(psStart, this.pos);
        setToken(out, Token.Redirect, op, tokenStart, this.pos);
        out.content = psText;
        out.targetPos = psStart;
        out.targetEnd = this.pos;
        return true;
      }
      this._redirectTargetPos = this.pos;
      if (nc !== CH_NL)
        this.readWordText();
    }
    this.redirectToken(out, op, tokenStart);
    return true;
  }
  redirectToken(out, operator, tokenStart) {
    setToken(out, Token.Redirect, operator, tokenStart, this.pos);
    out.content = this._wordText;
    out.targetPos = this._redirectTargetPos;
    out.targetEnd = this.pos;
  }
  readProcessSubstitution(out, operator, tokenStart) {
    this.pos++;
    this.extractBalanced();
    const text = this.src.slice(tokenStart, this.pos);
    setToken(out, Token.Word, text, tokenStart, this.pos);
  }
  readHereDocDelimiter() {
    const src = this.src;
    const len = src.length;
    let delimiter = "";
    if (this.pos < len && src.charCodeAt(this.pos) === CH_SQUOTE) {
      this.pos++;
      const start = this.pos;
      while (this.pos < len && src.charCodeAt(this.pos) !== CH_SQUOTE)
        this.pos++;
      delimiter = src.slice(start, this.pos);
      if (this.pos < len)
        this.pos++;
      this._hereDelim = delimiter;
      this._hereQuoted = true;
      return;
    } else if (this.pos < len && src.charCodeAt(this.pos) === CH_DQUOTE) {
      this.pos++;
      while (this.pos < len && src.charCodeAt(this.pos) !== CH_DQUOTE) {
        if (src.charCodeAt(this.pos) === CH_BACKSLASH)
          this.pos++;
        delimiter += src[this.pos];
        this.pos++;
      }
      if (this.pos < len)
        this.pos++;
      this._hereDelim = delimiter;
      this._hereQuoted = true;
      return;
    } else if (this.pos < len && src.charCodeAt(this.pos) === CH_BACKSLASH) {
      while (this.pos < len) {
        const c = src.charCodeAt(this.pos);
        if (c < 128 && charType[c] & 1)
          break;
        if (c === CH_BACKSLASH)
          this.pos++;
        if (this.pos < len) {
          delimiter += src[this.pos];
          this.pos++;
        }
      }
      this._hereDelim = delimiter;
      this._hereQuoted = true;
      return;
    } else {
      const start = this.pos;
      while (this.pos < len) {
        const c = src.charCodeAt(this.pos);
        if (c < 128 && charType[c] & 1)
          break;
        this.pos++;
      }
      this._hereDelim = src.slice(start, this.pos);
      this._hereQuoted = false;
    }
  }
  consumePendingHereDocs() {
    for (const hd of this.pendingHereDocs) {
      const bodyPos = this.pos;
      const body = this.readHereDocBody(hd.delimiter, hd.strip);
      if (hd.target) {
        hd.target.content = body;
        if (hd.quoted) {
          hd.target.heredocQuoted = true;
        } else if (body) {
          const parsed = this.parseHereDocBody(body, bodyPos);
          if (parsed)
            hd.target.body = parsed;
        }
      }
    }
    this.pendingHereDocs.length = 0;
  }
  readHereDocBody(delimiter, strip) {
    const src = this.src;
    const len = src.length;
    const dLen = delimiter.length;
    const bodyStart = this.pos;
    while (this.pos < len) {
      let lineStart = this.pos;
      let lineEnd = src.indexOf(`
`, this.pos);
      if (lineEnd === -1)
        lineEnd = len;
      if (strip) {
        while (lineStart < lineEnd && src.charCodeAt(lineStart) === CH_TAB)
          lineStart++;
      }
      if (lineEnd - lineStart === dLen && src.startsWith(delimiter, lineStart)) {
        const body = src.slice(bodyStart, this.pos);
        this.pos = lineEnd < len ? lineEnd + 1 : lineEnd;
        return body;
      }
      this.pos = lineEnd < len ? lineEnd + 1 : lineEnd;
    }
    return src.slice(bodyStart, this.pos);
  }
  parseHereDocBody(body, bodyPos) {
    let hasExpansion = false;
    for (let i = 0;i < body.length; i++) {
      const c = body.charCodeAt(i);
      if (c === CH_BACKTICK) {
        hasExpansion = true;
        break;
      }
      if (c === CH_DOLLAR) {
        const next = i + 1 < body.length ? body.charCodeAt(i + 1) : 0;
        if (next === CH_LBRACE || next === CH_LPAREN || next === CH_DOLLAR || next >= CH_a && next <= CH_z || next >= CH_A && next <= CH_Z || next === CH_UNDERSCORE || next === CH_BANG || next === CH_HASH || next === CH_AT || next === CH_STAR || next === CH_QUESTION || next === CH_DASH || next >= CH_0 && next <= CH_9) {
          hasExpansion = true;
          break;
        }
      }
      if (c === CH_BACKSLASH)
        i++;
    }
    if (!hasExpansion)
      return null;
    return new WordImpl(body, bodyPos, bodyPos + body.length);
  }
  _wordText = "";
  _wordQuoted = false;
  _wordHasExpansions = false;
  _wordParts = null;
  _redirectTargetPos = 0;
  _resultText = "";
  _resultHasExpansion = false;
  _resultPart;
  _dqText = "";
  _dqHasExpansions = false;
  _dqParts = null;
  _hereDelim = "";
  _hereQuoted = false;
  readWord(out, ctx, tokenStart = 0) {
    this.readWordText();
    const text = this._wordText;
    const hasExpansions = this._wordHasExpansions;
    const quoted = this._wordQuoted;
    const wordEnd = this.pos;
    if (ctx === LexContext.CommandStart) {
      if (!hasExpansions && !quoted) {
        const fc = text.charCodeAt(0);
        if ((fc >= CH_a && fc <= CH_z && text.length <= 8 || fc === CH_BANG || fc === CH_LBRACE || fc === CH_RBRACE) && text in RESERVED_WORDS) {
          setToken(out, RESERVED_WORDS[text], text, tokenStart, wordEnd);
          return;
        }
        if (fc === CH_LBRACKET && text === "[[") {
          setToken(out, Token.DblLBracket, text, tokenStart, wordEnd);
          return;
        }
      }
      if (isAssignmentWord(text)) {
        setToken(out, Token.Assignment, text, tokenStart, wordEnd);
        return;
      }
    }
    if (!hasExpansions && !quoted && text === "]]") {
      setToken(out, Token.DblRBracket, text, tokenStart, wordEnd);
      return;
    }
    if (!hasExpansions && this.pos < this.src.length) {
      const nc = this.src.charCodeAt(this.pos);
      if (nc === CH_LT || nc === CH_GT) {
        if (text.charCodeAt(0) >= CH_0 && text.charCodeAt(0) <= CH_9 && isAllDigits(text)) {
          const fd = Number.parseInt(text, 10);
          if (this.readRedirection(out, tokenStart)) {
            out.fileDescriptor = fd;
            return;
          }
        }
        if (text.charCodeAt(0) === CH_LBRACE && text.charCodeAt(text.length - 1) === CH_RBRACE && text.length > 2) {
          const varname = text.slice(1, -1);
          if (this.readRedirection(out, tokenStart)) {
            out.variableName = varname;
            return;
          }
        }
      }
    }
    setToken(out, Token.Word, text, tokenStart, wordEnd);
  }
  readWordText() {
    const src = this.src;
    const len = src.length;
    let pos = this.pos;
    const fastStart = pos;
    while (pos < len) {
      const c = src.charCodeAt(pos);
      if (c < 128 && charType[c])
        break;
      pos++;
    }
    const exitCh = pos < len ? src.charCodeAt(pos) : 0;
    if (pos >= len || charType[exitCh] & 1 && !(exitCh === CH_LPAREN && pos > fastStart && extglobPrefix[src.charCodeAt(pos - 1)])) {
      this.pos = pos;
      this._wordText = pos > fastStart ? src.slice(fastStart, pos) : "";
      this._wordQuoted = false;
      this._wordHasExpansions = false;
      if (this._buildParts)
        this._wordParts = null;
      return;
    }
    let text = pos > fastStart ? src.slice(fastStart, pos) : "";
    let quoted = false;
    let hasExpansions = false;
    const bp = this._buildParts;
    let parts;
    let litBuf = "";
    let litStart = 0;
    if (bp) {
      parts = [];
      litBuf = text;
      litStart = fastStart;
    }
    while (pos < len) {
      const ch = src.charCodeAt(pos);
      if (ch >= 128 || !charType[ch]) {
        const runStart = pos;
        pos++;
        while (pos < len) {
          const c = src.charCodeAt(pos);
          if (c < 128 && charType[c])
            break;
          pos++;
        }
        const chunk = src.slice(runStart, pos);
        text += chunk;
        if (bp)
          litBuf += chunk;
        continue;
      }
      if (charType[ch] & 1) {
        if (ch === CH_LPAREN && text.length > 0 && extglobPrefix[text.charCodeAt(text.length - 1)]) {
          const prefixChar = text.charCodeAt(text.length - 1);
          pos++;
          const innerStart = pos;
          let depth = 1;
          while (pos < len && depth > 0) {
            const c = src.charCodeAt(pos);
            if (c === CH_LPAREN)
              depth++;
            else if (c === CH_RPAREN)
              depth--;
            pos++;
          }
          const pattern = src.slice(innerStart, pos - 1);
          const eg = "(" + src.slice(innerStart, pos);
          text += eg;
          if (bp && prefixChar !== CH_EQ) {
            if (litBuf.length > 0) {
              const trimmed = litBuf.slice(0, -1);
              if (trimmed)
                parts.push({ type: "Literal", value: trimmed, text: src.slice(litStart, innerStart - 2) });
              litBuf = "";
            }
            const op = extglobOp[prefixChar];
            const fullText = op + eg;
            parts.push({ type: "ExtendedGlob", text: fullText, operator: op, pattern });
            litStart = pos;
          } else if (bp) {
            litBuf += eg;
          }
          continue;
        }
        break;
      }
      if (ch === CH_BACKSLASH) {
        pos++;
        if (pos < len) {
          if (src.charCodeAt(pos) === CH_NL) {
            pos++;
          } else {
            quoted = true;
            const escaped = src[pos++];
            text += escaped;
            if (bp)
              litBuf += escaped;
          }
        }
        continue;
      }
      if (ch === CH_SQUOTE) {
        const sqStart = pos;
        quoted = true;
        pos++;
        const start = pos;
        while (pos < len && src.charCodeAt(pos) !== CH_SQUOTE)
          pos++;
        const value = src.slice(start, pos);
        text += value;
        if (pos < len)
          pos++;
        else
          this.errors.push({ message: "unterminated single quote", pos: start - 1 });
        if (bp) {
          if (litBuf) {
            parts.push({ type: "Literal", value: litBuf, text: src.slice(litStart, sqStart) });
            litBuf = "";
          }
          parts.push({ type: "SingleQuoted", value, text: src.slice(sqStart, pos) });
          litStart = pos;
        }
        continue;
      }
      if (ch === CH_DQUOTE) {
        const dqStart = pos;
        quoted = true;
        pos++;
        this.pos = pos;
        this.readDoubleQuoted();
        pos = this.pos;
        text += this._dqText;
        if (this._dqHasExpansions)
          hasExpansions = true;
        if (bp) {
          if (litBuf) {
            parts.push({ type: "Literal", value: litBuf, text: src.slice(litStart, dqStart) });
            litBuf = "";
          }
          const dqText = src.slice(dqStart, pos);
          parts.push({
            type: "DoubleQuoted",
            text: dqText,
            parts: this._dqParts ?? [{ type: "Literal", value: this._dqText, text: src.slice(dqStart + 1, pos - 1) }]
          });
          litStart = pos;
        }
        continue;
      }
      if (ch === CH_DOLLAR) {
        const dollarStart = pos;
        this.pos = pos;
        this.readDollar();
        pos = this.pos;
        text += this._resultText;
        if (this._resultHasExpansion)
          hasExpansions = true;
        if (bp) {
          if (this._resultPart) {
            if (litBuf) {
              parts.push({ type: "Literal", value: litBuf, text: src.slice(litStart, dollarStart) });
              litBuf = "";
            }
            parts.push(this._resultPart);
            litStart = pos;
          } else {
            litBuf += this._resultText;
          }
        }
        continue;
      }
      if (ch === CH_BACKTICK) {
        const btStart = pos;
        this.pos = pos;
        this.readBacktickExpansion();
        pos = this.pos;
        text += this._resultText;
        hasExpansions = true;
        if (bp) {
          if (litBuf) {
            parts.push({ type: "Literal", value: litBuf, text: src.slice(litStart, btStart) });
            litBuf = "";
          }
          parts.push(this._resultPart);
          litStart = pos;
        }
        continue;
      }
      if (ch === CH_LBRACE) {
        const braceEnd = scanBraceExpansion(src, pos, len);
        if (braceEnd > 0) {
          const braceText = src.slice(pos, braceEnd);
          text += braceText;
          if (bp) {
            if (litBuf) {
              parts.push({ type: "Literal", value: litBuf, text: src.slice(litStart, pos) });
              litBuf = "";
            }
            parts.push({ type: "BraceExpansion", text: braceText });
            litStart = braceEnd;
          }
          pos = braceEnd;
          continue;
        }
        text += "{";
        if (bp)
          litBuf += "{";
        pos++;
        continue;
      }
      pos++;
    }
    if (bp && litBuf)
      parts.push({ type: "Literal", value: litBuf, text: src.slice(litStart, pos) });
    this.pos = pos;
    this._wordText = text;
    this._wordQuoted = quoted;
    this._wordHasExpansions = hasExpansions;
    if (bp) {
      this._wordParts = parts.length > 1 || parts.length === 1 && parts[0].type !== "Literal" ? parts : null;
    }
  }
  readInnerWordText() {
    const src = this.src;
    const len = src.length;
    let pos = this.pos;
    let text = "";
    const bp = this._buildParts;
    let parts;
    let litBuf = "";
    let litStart = 0;
    if (bp) {
      parts = [];
      litStart = pos;
    }
    while (pos < len) {
      const ch = src.charCodeAt(pos);
      if (ch === CH_BACKSLASH) {
        pos++;
        if (pos < len) {
          if (src.charCodeAt(pos) === CH_NL) {
            pos++;
          } else {
            const escaped = src[pos++];
            text += escaped;
            if (bp)
              litBuf += escaped;
          }
        }
        continue;
      }
      if (ch === CH_SQUOTE) {
        const sqStart = pos;
        pos++;
        const start = pos;
        while (pos < len && src.charCodeAt(pos) !== CH_SQUOTE)
          pos++;
        const value = src.slice(start, pos);
        text += value;
        if (pos < len)
          pos++;
        if (bp) {
          if (litBuf) {
            parts.push({ type: "Literal", value: litBuf, text: src.slice(litStart, sqStart) });
            litBuf = "";
          }
          parts.push({ type: "SingleQuoted", value, text: src.slice(sqStart, pos) });
          litStart = pos;
        }
        continue;
      }
      if (ch === CH_DQUOTE) {
        const dqStart = pos;
        pos++;
        this.pos = pos;
        this.readDoubleQuoted();
        pos = this.pos;
        text += this._dqText;
        if (bp) {
          if (litBuf) {
            parts.push({ type: "Literal", value: litBuf, text: src.slice(litStart, dqStart) });
            litBuf = "";
          }
          const dqText = src.slice(dqStart, pos);
          parts.push({
            type: "DoubleQuoted",
            text: dqText,
            parts: this._dqParts ?? [{ type: "Literal", value: this._dqText, text: src.slice(dqStart + 1, pos - 1) }]
          });
          litStart = pos;
        }
        continue;
      }
      if (ch === CH_DOLLAR) {
        const dollarStart = pos;
        this.pos = pos;
        this.readDollar();
        pos = this.pos;
        text += this._resultText;
        if (bp) {
          if (this._resultPart) {
            if (litBuf) {
              parts.push({ type: "Literal", value: litBuf, text: src.slice(litStart, dollarStart) });
              litBuf = "";
            }
            parts.push(this._resultPart);
            litStart = pos;
          } else {
            litBuf += this._resultText;
          }
        }
        continue;
      }
      if (ch === CH_BACKTICK) {
        const btStart = pos;
        this.pos = pos;
        this.readBacktickExpansion();
        pos = this.pos;
        text += this._resultText;
        if (bp) {
          if (litBuf) {
            parts.push({ type: "Literal", value: litBuf, text: src.slice(litStart, btStart) });
            litBuf = "";
          }
          parts.push(this._resultPart);
          litStart = pos;
        }
        continue;
      }
      text += src[pos];
      if (bp)
        litBuf += src[pos];
      pos++;
    }
    if (bp && litBuf)
      parts.push({ type: "Literal", value: litBuf, text: src.slice(litStart, pos) });
    this.pos = pos;
    this._wordText = text;
    this._wordQuoted = false;
    this._wordHasExpansions = false;
    if (bp) {
      this._wordParts = parts.length > 1 || parts.length === 1 && parts[0].type !== "Literal" ? parts : null;
    }
  }
  parseSubFieldWord(s) {
    if (!s)
      return new WordImpl("", 0, 0);
    const savedSrc = this.src;
    const savedPos = this.pos;
    const savedText = this._wordText;
    const savedParts = this._wordParts;
    const savedQuoted = this._wordQuoted;
    this.src = s;
    this.pos = 0;
    this.readInnerWordText();
    const word = new WordImpl(this._wordText, 0, 0);
    if (this._buildParts && this._wordParts) {
      word.parts = this._wordParts;
    }
    this.src = savedSrc;
    this.pos = savedPos;
    this._wordText = savedText;
    this._wordParts = savedParts;
    this._wordQuoted = savedQuoted;
    return word;
  }
  skipSQ() {
    while (this.pos < this.src.length && this.src.charCodeAt(this.pos) !== CH_SQUOTE)
      this.pos++;
    if (this.pos < this.src.length)
      this.pos++;
  }
  skipDQ() {
    const src = this.src;
    const len = src.length;
    while (this.pos < len) {
      const ch = src.charCodeAt(this.pos);
      if (ch === CH_DQUOTE) {
        this.pos++;
        return;
      }
      if (ch === CH_BACKSLASH) {
        this.pos += 2;
        continue;
      }
      if (ch === CH_DOLLAR && this.pos + 1 < len) {
        const next = src.charCodeAt(this.pos + 1);
        if (next === CH_LPAREN) {
          this.pos += 2;
          this.extractBalanced();
          continue;
        }
        if (next === CH_LBRACE) {
          this.pos += 2;
          let d = 1;
          while (this.pos < len && d > 0) {
            const c = src.charCodeAt(this.pos);
            if (c === CH_RBRACE) {
              if (--d === 0) {
                this.pos++;
                break;
              }
            } else if (c === CH_LBRACE && this.pos > 0 && src.charCodeAt(this.pos - 1) === CH_DOLLAR)
              d++;
            else if (c === CH_BACKSLASH) {
              this.pos++;
            } else if (c === CH_SQUOTE) {
              this.pos++;
              this.skipSQ();
              continue;
            } else if (c === CH_DQUOTE) {
              this.pos++;
              this.skipDQ();
              continue;
            }
            this.pos++;
          }
          continue;
        }
      }
      if (ch === CH_BACKTICK) {
        this.pos++;
        while (this.pos < len && src.charCodeAt(this.pos) !== CH_BACKTICK) {
          if (src.charCodeAt(this.pos) === CH_BACKSLASH)
            this.pos++;
          this.pos++;
        }
        if (this.pos < len)
          this.pos++;
        continue;
      }
      this.pos++;
    }
  }
  skipSpacesAndTabs() {
    const src = this.src;
    const len = src.length;
    while (this.pos < len) {
      const ch = src.charCodeAt(this.pos);
      if (ch === CH_SPACE || ch === CH_TAB)
        this.pos++;
      else if (ch === CH_BACKSLASH && this.pos + 1 < len && src.charCodeAt(this.pos + 1) === CH_NL)
        this.pos += 2;
      else
        break;
    }
  }
  readDoubleQuoted() {
    const src = this.src;
    const len = src.length;
    const contentStart = this.pos;
    let hasExpansions = false;
    const bp = this._buildParts;
    if (!bp) {
      let p = this.pos;
      while (p < len) {
        const c = src.charCodeAt(p);
        if (c === CH_DQUOTE) {
          this._dqText = src.slice(contentStart, p);
          this.pos = p + 1;
          this._dqHasExpansions = false;
          this._dqParts = null;
          return;
        }
        if (c === CH_DOLLAR || c === CH_BACKTICK || c === CH_BACKSLASH)
          break;
        p++;
      }
    }
    let text = "";
    let parts = null;
    let litBuf = "";
    let litStart = bp ? this.pos : 0;
    while (this.pos < len && src.charCodeAt(this.pos) !== CH_DQUOTE) {
      const runStart = this.pos;
      while (this.pos < len) {
        const c = src.charCodeAt(this.pos);
        if (c === CH_DQUOTE || c === CH_BACKSLASH || c === CH_DOLLAR || c === CH_BACKTICK)
          break;
        this.pos++;
      }
      if (this.pos > runStart) {
        const chunk = src.slice(runStart, this.pos);
        text += chunk;
        if (bp)
          litBuf += chunk;
      }
      if (this.pos >= len || src.charCodeAt(this.pos) === CH_DQUOTE)
        break;
      const ch = src.charCodeAt(this.pos);
      if (ch === CH_BACKSLASH) {
        this.pos++;
        if (this.pos < len) {
          const next = src.charCodeAt(this.pos);
          if (next === CH_NL) {
            this.pos++;
            continue;
          }
          if (next === CH_DOLLAR || next === CH_BACKTICK || next === CH_DQUOTE || next === CH_BACKSLASH) {
            const c = src[this.pos];
            text += c;
            if (bp)
              litBuf += c;
          } else {
            const pair = "\\" + src[this.pos];
            text += pair;
            if (bp)
              litBuf += pair;
          }
          this.pos++;
        }
        continue;
      }
      if (ch === CH_DOLLAR) {
        if (this.pos + 1 < len && src.charCodeAt(this.pos + 1) === CH_DQUOTE) {
          text += "$";
          if (bp)
            litBuf += "$";
          this.pos++;
          continue;
        }
        const expStart = this.pos;
        this.readDollar();
        text += this._resultText;
        if (this._resultHasExpansion)
          hasExpansions = true;
        if (bp) {
          const rp = this._resultPart;
          if (rp && isDQChild(rp)) {
            if (!parts)
              parts = [];
            if (litBuf) {
              parts.push({ type: "Literal", value: litBuf, text: src.slice(litStart, expStart) });
              litBuf = "";
            }
            parts.push(rp);
            litStart = this.pos;
          } else {
            litBuf += this._resultText;
          }
        }
        continue;
      }
      if (ch === CH_BACKTICK) {
        const btStart = this.pos;
        this.readBacktickExpansion();
        text += this._resultText;
        hasExpansions = true;
        if (bp && this._resultPart && isDQChild(this._resultPart)) {
          if (!parts)
            parts = [];
          if (litBuf) {
            parts.push({ type: "Literal", value: litBuf, text: src.slice(litStart, btStart) });
            litBuf = "";
          }
          parts.push(this._resultPart);
          litStart = this.pos;
        }
        continue;
      }
    }
    if (bp && parts && litBuf)
      parts.push({ type: "Literal", value: litBuf, text: src.slice(litStart, this.pos) });
    if (this.pos < len)
      this.pos++;
    else
      this.errors.push({ message: "unterminated double quote", pos: contentStart - 1 });
    this._dqText = text;
    this._dqHasExpansions = hasExpansions;
    this._dqParts = parts;
  }
  readDollar() {
    const dollarPos = this.pos;
    this.pos++;
    const src = this.src;
    const len = src.length;
    if (this.pos >= len) {
      this._resultText = "$";
      this._resultHasExpansion = false;
      this._resultPart = undefined;
      return;
    }
    const ch = src.charCodeAt(this.pos);
    if (ch === CH_LPAREN) {
      if (this.pos + 1 < len && src.charCodeAt(this.pos + 1) === CH_LPAREN) {
        this.readArithmeticExpansion();
        return;
      }
      this.readCommandSubstitution();
      return;
    }
    if (ch === CH_LBRACE) {
      const after = this.pos + 1 < len ? src.charCodeAt(this.pos + 1) : 0;
      if (after === CH_SPACE || after === CH_TAB || after === CH_NL) {
        this.readBraceCommandSubstitution();
        return;
      }
      if (after === CH_PIPE) {
        this.readValueSubstitution();
        return;
      }
      this.readParameterExpansion();
      return;
    }
    if (ch === CH_SQUOTE) {
      this.pos++;
      const value = this.readAnsiCQuoted();
      this._resultText = value;
      this._resultHasExpansion = false;
      this._resultPart = this._buildParts ? { type: "AnsiCQuoted", text: src.slice(dollarPos, this.pos), value } : undefined;
      return;
    }
    if (ch === CH_DQUOTE) {
      this.pos++;
      this.readDoubleQuoted();
      this._resultText = this._dqText;
      this._resultHasExpansion = this._dqHasExpansions;
      if (this._buildParts) {
        const text = src.slice(dollarPos, this.pos);
        this._resultPart = {
          type: "LocaleString",
          text,
          parts: this._dqParts ?? [
            { type: "Literal", value: this._dqText, text: src.slice(dollarPos + 2, this.pos - 1) }
          ]
        };
      } else {
        this._resultPart = undefined;
      }
      return;
    }
    if (ch === CH_AT || ch === CH_STAR || ch === CH_HASH || ch === CH_QUESTION || ch === CH_DASH || ch === CH_DOLLAR || ch === CH_BANG) {
      this.pos++;
      const text = src.slice(this.pos - 2, this.pos);
      this._resultText = text;
      this._resultHasExpansion = false;
      this._resultPart = this._buildParts ? { type: "SimpleExpansion", text } : undefined;
      return;
    }
    if (ch >= CH_0 && ch <= CH_9) {
      this.pos++;
      const text = src.slice(this.pos - 2, this.pos);
      this._resultText = text;
      this._resultHasExpansion = false;
      this._resultPart = this._buildParts ? { type: "SimpleExpansion", text } : undefined;
      return;
    }
    if (ch < 128 && isIdChar[ch] & 1) {
      const dollarPos2 = this.pos - 1;
      while (this.pos < len) {
        const c = src.charCodeAt(this.pos);
        if (c < 128 && isIdChar[c] & 2)
          this.pos++;
        else
          break;
      }
      const text = src.slice(dollarPos2, this.pos);
      this._resultText = text;
      this._resultHasExpansion = false;
      this._resultPart = this._buildParts ? { type: "SimpleExpansion", text } : undefined;
      return;
    }
    this._resultText = "$";
    this._resultHasExpansion = false;
    this._resultPart = undefined;
  }
  scanArithmeticBody() {
    this.pos += 2;
    let depth = 1;
    const src = this.src;
    const len = src.length;
    const start = this.pos;
    while (this.pos < len && depth > 0) {
      const c = src.charCodeAt(this.pos);
      if (c === CH_LPAREN && this.pos + 1 < len && src.charCodeAt(this.pos + 1) === CH_LPAREN) {
        depth++;
        this.pos += 2;
      } else if (c === CH_RPAREN && this.pos + 1 < len && src.charCodeAt(this.pos + 1) === CH_RPAREN) {
        if (--depth === 0) {
          this.pos += 2;
          break;
        }
        this.pos += 2;
      } else {
        this.pos++;
      }
    }
    return src.slice(start, this.pos - 2);
  }
  readArithmeticExpansion() {
    const body = this.scanArithmeticBody();
    const text = "$((" + body + "))";
    this._resultText = text;
    this._resultHasExpansion = false;
    if (this._buildParts) {
      const expr = parseArithmeticExpression(body) ?? undefined;
      this._resultPart = { type: "ArithmeticExpansion", text, expression: expr };
    } else {
      this._resultPart = undefined;
    }
  }
  readArithmeticCommand(out, tokenStart) {
    const body = this.scanArithmeticBody();
    setToken(out, Token.ArithCmd, body, tokenStart, this.pos);
  }
  readCommandSubstitution() {
    const dollarPos = this.pos - 1;
    this.pos++;
    this.extractBalanced();
    const text = this.src.slice(dollarPos, this.pos);
    this._resultText = text;
    this._resultHasExpansion = true;
    if (this._buildParts) {
      const inner = text.slice(2, -1);
      this._resultPart = { type: "CommandExpansion", text, script: undefined, inner };
      this.collectedExpansions.push({ inner, _part: this._resultPart });
    } else {
      this._resultPart = undefined;
    }
  }
  readBraceCommandSubstitution() {
    this.readBraceSubstitution("${ ", 1);
  }
  readValueSubstitution() {
    this.readBraceSubstitution("${| ", 2);
  }
  readBraceSubstitution(prefix, skip) {
    this.pos += skip;
    const src = this.src;
    const len = src.length;
    let depth = 1;
    const start = this.pos;
    while (this.pos < len) {
      const c = src.charCodeAt(this.pos);
      if (c === CH_LBRACE)
        depth++;
      else if (c === CH_RBRACE) {
        if (--depth === 0) {
          this.pos++;
          break;
        }
      } else if (c === CH_SQUOTE) {
        this.pos++;
        this.skipSQ();
        continue;
      } else if (c === CH_DQUOTE) {
        this.pos++;
        this.skipDQ();
        continue;
      } else if (c === CH_BACKSLASH)
        this.pos++;
      this.pos++;
    }
    const inner = src.slice(start, this.pos - 1).trim();
    const text = prefix + inner + " }";
    this._resultText = text;
    this._resultHasExpansion = true;
    if (this._buildParts) {
      this._resultPart = { type: "CommandExpansion", text, script: undefined, inner };
      this.collectedExpansions.push({ inner, _part: this._resultPart });
    } else {
      this._resultPart = undefined;
    }
  }
  readBacktickExpansion() {
    this.pos++;
    const src = this.src;
    const len = src.length;
    let inner = "";
    const start = this.pos;
    let hasEscapes = false;
    while (this.pos < len && src.charCodeAt(this.pos) !== CH_BACKTICK) {
      if (src.charCodeAt(this.pos) === CH_BACKSLASH) {
        hasEscapes = true;
        break;
      }
      this.pos++;
    }
    if (!hasEscapes) {
      inner = src.slice(start, this.pos);
    } else {
      inner = src.slice(start, this.pos);
      while (this.pos < len && src.charCodeAt(this.pos) !== CH_BACKTICK) {
        if (src.charCodeAt(this.pos) === CH_BACKSLASH) {
          this.pos++;
          if (this.pos < len) {
            const c = src.charCodeAt(this.pos);
            if (c === CH_DOLLAR || c === CH_BACKTICK || c === CH_BACKSLASH) {
              inner += src[this.pos];
            } else {
              inner += "\\" + src[this.pos];
            }
            this.pos++;
          }
        } else {
          const runStart = this.pos;
          while (this.pos < len) {
            const c = src.charCodeAt(this.pos);
            if (c === CH_BACKTICK || c === CH_BACKSLASH)
              break;
            this.pos++;
          }
          inner += src.slice(runStart, this.pos);
        }
      }
    }
    if (this.pos < len)
      this.pos++;
    else
      this.errors.push({ message: "unterminated backtick", pos: start - 1 });
    const text = src.slice(start - 1, this.pos);
    this._resultText = inner;
    this._resultHasExpansion = true;
    if (this._buildParts) {
      this._resultPart = { type: "CommandExpansion", text, script: undefined, inner };
      this.collectedExpansions.push({ inner, _part: this._resultPart });
    } else {
      this._resultPart = undefined;
    }
  }
  readParameterExpansion() {
    const src = this.src;
    const len = src.length;
    const start = this.pos;
    this.pos++;
    let depth = 1;
    while (this.pos < len && depth > 0) {
      const ch = src.charCodeAt(this.pos);
      if (ch === CH_LBRACE && this.pos > 0 && src.charCodeAt(this.pos - 1) === CH_DOLLAR)
        depth++;
      else if (ch === CH_RBRACE) {
        if (--depth === 0) {
          this.pos++;
          break;
        }
      } else if (ch === CH_BACKSLASH) {
        this.pos++;
      } else if (ch === CH_SQUOTE) {
        this.pos++;
        this.skipSQ();
        continue;
      } else if (ch === CH_DQUOTE) {
        this.pos++;
        this.skipDQ();
        continue;
      }
      this.pos++;
    }
    const text = src.slice(start - 1, this.pos);
    this._resultText = text;
    this._resultHasExpansion = false;
    if (this._buildParts) {
      const inner = src.slice(start + 1, this.pos - 1);
      this._resultPart = this.parseParamInner(text, inner);
    } else {
      this._resultPart = undefined;
    }
  }
  parseParamInner(text, inner) {
    const result = {
      type: "ParameterExpansion",
      text,
      parameter: "",
      index: undefined,
      indirect: undefined,
      length: undefined,
      operator: undefined,
      operand: undefined,
      slice: undefined,
      replace: undefined
    };
    const ilen = inner.length;
    if (ilen === 0)
      return result;
    let i = 0;
    if (inner.charCodeAt(0) === CH_BANG) {
      result.indirect = true;
      i = 1;
    }
    if (!result.indirect && inner.charCodeAt(0) === CH_HASH) {
      if (ilen === 1) {
        result.parameter = "#";
        return result;
      }
      if (inner.charCodeAt(1) === CH_HASH) {
        result.parameter = "#";
        i = 1;
      } else {
        const tryI = this.scanParamName(inner, 1);
        if (tryI > 1) {
          let endI = tryI;
          if (endI < ilen && inner.charCodeAt(endI) === CH_LBRACKET) {
            const closeB = this.findCloseBracket(inner, endI + 1);
            if (closeB !== -1)
              endI = closeB + 1;
          }
          if (endI >= ilen) {
            result.length = true;
            result.parameter = inner.slice(1, tryI);
            if (tryI < ilen && inner.charCodeAt(tryI) === CH_LBRACKET) {
              const closeB = this.findCloseBracket(inner, tryI + 1);
              if (closeB !== -1)
                result.index = inner.slice(tryI + 1, closeB);
            }
            return result;
          }
        }
        result.parameter = "#";
        i = 1;
      }
    }
    if (!result.parameter) {
      const nameStart = i;
      i = this.scanParamName(inner, i);
      result.parameter = inner.slice(nameStart, i);
    }
    if (i < ilen && inner.charCodeAt(i) === CH_LBRACKET) {
      const closeB = this.findCloseBracket(inner, i + 1);
      if (closeB !== -1) {
        result.index = inner.slice(i + 1, closeB);
        i = closeB + 1;
      }
    }
    if (i >= ilen)
      return result;
    const opChar = inner.charCodeAt(i);
    if (opChar === CH_COLON) {
      if (i + 1 < ilen) {
        const nc = inner.charCodeAt(i + 1);
        if (nc === CH_DASH || nc === CH_EQ || nc === CH_PLUS || nc === CH_QUESTION) {
          result.operator = inner.slice(i, i + 2);
          result.operand = this.parseSubFieldWord(inner.slice(i + 2));
          return result;
        }
      }
      i++;
      const sliceRest = inner.slice(i);
      const colonIdx = findUnnested(sliceRest, CH_COLON);
      if (colonIdx === -1) {
        result.slice = { offset: this.parseSubFieldWord(sliceRest), length: undefined };
      } else {
        result.slice = {
          offset: this.parseSubFieldWord(sliceRest.slice(0, colonIdx)),
          length: this.parseSubFieldWord(sliceRest.slice(colonIdx + 1))
        };
      }
      return result;
    }
    if (opChar === CH_DASH || opChar === CH_EQ || opChar === CH_PLUS || opChar === CH_QUESTION) {
      result.operator = inner[i];
      result.operand = this.parseSubFieldWord(inner.slice(i + 1));
      return result;
    }
    if (opChar === CH_HASH) {
      if (i + 1 < ilen && inner.charCodeAt(i + 1) === CH_HASH) {
        result.operator = "##";
        result.operand = this.parseSubFieldWord(inner.slice(i + 2));
      } else {
        result.operator = "#";
        result.operand = this.parseSubFieldWord(inner.slice(i + 1));
      }
      return result;
    }
    if (opChar === CH_PERCENT) {
      if (i + 1 < ilen && inner.charCodeAt(i + 1) === CH_PERCENT) {
        result.operator = "%%";
        result.operand = this.parseSubFieldWord(inner.slice(i + 2));
      } else {
        result.operator = "%";
        result.operand = this.parseSubFieldWord(inner.slice(i + 1));
      }
      return result;
    }
    if (opChar === CH_SLASH) {
      i++;
      let replOp = "/";
      if (i < ilen) {
        const nc = inner.charCodeAt(i);
        if (nc === CH_SLASH) {
          replOp = "//";
          i++;
        } else if (nc === CH_HASH) {
          replOp = "/#";
          i++;
        } else if (nc === CH_PERCENT) {
          replOp = "/%";
          i++;
        }
      }
      result.operator = replOp;
      const rest = inner.slice(i);
      const sepIdx = findUnnested(rest, CH_SLASH);
      if (sepIdx === -1) {
        result.replace = {
          pattern: this.parseSubFieldWord(rest),
          replacement: new WordImpl("", 0, 0)
        };
      } else {
        result.replace = {
          pattern: this.parseSubFieldWord(rest.slice(0, sepIdx)),
          replacement: this.parseSubFieldWord(rest.slice(sepIdx + 1))
        };
      }
      return result;
    }
    if (opChar === CH_CARET) {
      if (i + 1 < ilen && inner.charCodeAt(i + 1) === CH_CARET) {
        result.operator = "^^";
        const rest = inner.slice(i + 2);
        if (rest)
          result.operand = this.parseSubFieldWord(rest);
      } else {
        result.operator = "^";
        const rest = inner.slice(i + 1);
        if (rest)
          result.operand = this.parseSubFieldWord(rest);
      }
      return result;
    }
    if (opChar === CH_COMMA) {
      if (i + 1 < ilen && inner.charCodeAt(i + 1) === CH_COMMA) {
        result.operator = ",,";
        const rest = inner.slice(i + 2);
        if (rest)
          result.operand = this.parseSubFieldWord(rest);
      } else {
        result.operator = ",";
        const rest = inner.slice(i + 1);
        if (rest)
          result.operand = this.parseSubFieldWord(rest);
      }
      return result;
    }
    if (opChar === CH_AT) {
      result.operator = "@";
      result.operand = this.parseSubFieldWord(inner.slice(i + 1));
      return result;
    }
    result.operator = inner.slice(i);
    return result;
  }
  scanParamName(s, start) {
    let i = start;
    if (i >= s.length)
      return i;
    const c = s.charCodeAt(i);
    if (c === CH_AT || c === CH_STAR || c === CH_HASH || c === CH_QUESTION || c === CH_DASH || c === CH_DOLLAR || c === CH_BANG) {
      return i + 1;
    }
    if (c >= CH_0 && c <= CH_9) {
      while (i < s.length && s.charCodeAt(i) >= CH_0 && s.charCodeAt(i) <= CH_9)
        i++;
      return i;
    }
    if (c >= CH_a && c <= CH_z || c >= CH_A && c <= CH_Z || c === CH_UNDERSCORE) {
      i++;
      while (i < s.length) {
        const ch = s.charCodeAt(i);
        if (ch >= CH_a && ch <= CH_z || ch >= CH_A && ch <= CH_Z || ch >= CH_0 && ch <= CH_9 || ch === CH_UNDERSCORE)
          i++;
        else
          break;
      }
    }
    return i;
  }
  findCloseBracket(s, start) {
    let depth = 1;
    for (let i = start;i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === CH_LBRACKET)
        depth++;
      else if (c === CH_RBRACKET) {
        if (--depth === 0)
          return i;
      }
    }
    return -1;
  }
  readAnsiCQuoted() {
    const src = this.src;
    const len = src.length;
    let text = "";
    while (this.pos < len && src.charCodeAt(this.pos) !== CH_SQUOTE) {
      if (src.charCodeAt(this.pos) === CH_BACKSLASH && this.pos + 1 < len) {
        this.pos++;
        const ch = src[this.pos];
        switch (ch) {
          case "n":
            text += `
`;
            break;
          case "t":
            text += "\t";
            break;
          case "r":
            text += "\r";
            break;
          case "\\":
            text += "\\";
            break;
          case "'":
            text += "'";
            break;
          case '"':
            text += '"';
            break;
          case "a":
            text += "\x07";
            break;
          case "b":
            text += "\b";
            break;
          case "e":
          case "E":
            text += "\x1B";
            break;
          case "f":
            text += "\f";
            break;
          case "v":
            text += "\v";
            break;
          default:
            text += "\\" + ch;
            break;
        }
        this.pos++;
      } else {
        const runStart = this.pos;
        while (this.pos < len) {
          const c = src.charCodeAt(this.pos);
          if (c === CH_SQUOTE || c === CH_BACKSLASH)
            break;
          this.pos++;
        }
        text += src.slice(runStart, this.pos);
      }
    }
    if (this.pos < len)
      this.pos++;
    return text;
  }
  extractBalanced() {
    const src = this.src;
    const len = src.length;
    let depth = 1;
    const start = this.pos;
    while (this.pos < len && depth > 0) {
      const c = src.charCodeAt(this.pos);
      if (c === CH_RPAREN) {
        depth--;
        if (depth === 0) {
          const result = src.slice(start, this.pos);
          this.pos++;
          return result;
        }
        this.pos++;
      } else if (c === CH_LPAREN || c === CH_BACKSLASH || c === CH_SQUOTE || c === CH_DQUOTE || c === CH_BACKTICK) {
        break;
      } else if (c === 99 && (this.pos === start || src.charCodeAt(this.pos - 1) < 128 && charType[src.charCodeAt(this.pos - 1)] !== 0) && this.pos + 3 < len && src.charCodeAt(this.pos + 1) === 97 && src.charCodeAt(this.pos + 2) === 115 && src.charCodeAt(this.pos + 3) === 101 && (this.pos + 4 >= len || src.charCodeAt(this.pos + 4) < 128 && charType[src.charCodeAt(this.pos + 4)] & 1)) {
        break;
      } else {
        this.pos++;
      }
    }
    if (depth === 0)
      return src.slice(start, this.pos);
    let caseDepth = 0;
    while (this.pos < len && depth > 0) {
      const ch = src.charCodeAt(this.pos);
      if (ch === CH_LPAREN) {
        depth++;
        this.pos++;
      } else if (ch === CH_RPAREN) {
        if (caseDepth > 0) {
          this.pos++;
        } else {
          depth--;
          if (depth === 0) {
            const result = src.slice(start, this.pos);
            this.pos++;
            return result;
          }
          this.pos++;
        }
      } else if (ch === CH_BACKSLASH) {
        this.pos++;
        if (this.pos < len)
          this.pos++;
      } else if (ch === CH_SQUOTE) {
        this.pos++;
        this.skipSQ();
      } else if (ch === CH_DQUOTE) {
        this.pos++;
        this.skipDQ();
      } else if (ch === CH_BACKTICK) {
        this.pos++;
        while (this.pos < len && src.charCodeAt(this.pos) !== CH_BACKTICK) {
          if (src.charCodeAt(this.pos) === CH_BACKSLASH)
            this.pos++;
          if (this.pos < len)
            this.pos++;
        }
        if (this.pos < len)
          this.pos++;
      } else {
        const wStart = this.pos;
        while (this.pos < len) {
          const wc = src.charCodeAt(this.pos);
          if (wc < 128 && charType[wc])
            break;
          this.pos++;
        }
        if (this.pos > wStart) {
          const wLen = this.pos - wStart;
          if (wLen === 4) {
            const c0 = src.charCodeAt(wStart);
            if (c0 === 99 && src.charCodeAt(wStart + 1) === 97 && src.charCodeAt(wStart + 2) === 115 && src.charCodeAt(wStart + 3) === 101) {
              caseDepth++;
            } else if (c0 === 101 && src.charCodeAt(wStart + 1) === 115 && src.charCodeAt(wStart + 2) === 97 && src.charCodeAt(wStart + 3) === 99 && caseDepth > 0) {
              caseDepth--;
            }
          }
        } else {
          this.pos++;
        }
      }
    }
    return src.slice(start, this.pos);
  }
}

// node_modules/unbash/dist/parts.js
function computeWordParts(source, word) {
  const lexer = new Lexer(source);
  let parts;
  if (word.text.includes(`
`) && word.pos > 0) {
    parts = lexer.buildHereDocParts(word.pos, word.end);
  } else {
    parts = lexer.buildWordParts(word.pos);
  }
  if (!parts)
    return;
  for (const exp of lexer.getCollectedExpansions()) {
    resolveExpansion(exp);
  }
  return parts;
}
function resolveExpansion(e) {
  if (e.inner !== undefined && e._part) {
    e._part.script = parse(e.inner);
    e._part.inner = undefined;
    e._part = undefined;
    e.inner = undefined;
  }
}

// node_modules/unbash/dist/parser.js
WordImpl._resolve = computeWordParts;

class ArithmeticCommandImpl {
  type = "ArithmeticCommand";
  pos;
  end;
  body;
  #expression = null;
  constructor(pos, end, body) {
    this.pos = pos;
    this.end = end;
    this.body = body;
  }
  get expression() {
    if (this.#expression === null) {
      this.#expression = parseArithmeticExpression(this.body, this.pos + 2) ?? undefined;
    }
    return this.#expression;
  }
  set expression(v) {
    this.#expression = v ?? undefined;
  }
}

class ArithmeticForImpl {
  type = "ArithmeticFor";
  pos;
  end;
  body;
  #initStr;
  #testStr;
  #updateStr;
  #initPos;
  #testPos;
  #updatePos;
  #initialize = null;
  #test = null;
  #update = null;
  constructor(pos, end, body, initStr, testStr, updateStr, initPos, testPos, updatePos) {
    this.pos = pos;
    this.end = end;
    this.body = body;
    this.#initStr = initStr;
    this.#testStr = testStr;
    this.#updateStr = updateStr;
    this.#initPos = initPos;
    this.#testPos = testPos;
    this.#updatePos = updatePos;
  }
  get initialize() {
    if (this.#initialize === null) {
      if (this.#initStr) {
        const expr = parseArithmeticExpression(this.#initStr);
        if (expr)
          offsetArith(expr, this.#initPos);
        this.#initialize = expr ?? undefined;
      } else {
        this.#initialize = undefined;
      }
    }
    return this.#initialize;
  }
  set initialize(v) {
    this.#initialize = v ?? undefined;
  }
  get test() {
    if (this.#test === null) {
      if (this.#testStr) {
        const expr = parseArithmeticExpression(this.#testStr);
        if (expr)
          offsetArith(expr, this.#testPos);
        this.#test = expr ?? undefined;
      } else {
        this.#test = undefined;
      }
    }
    return this.#test;
  }
  set test(v) {
    this.#test = v ?? undefined;
  }
  get update() {
    if (this.#update === null) {
      if (this.#updateStr) {
        const expr = parseArithmeticExpression(this.#updateStr);
        if (expr)
          offsetArith(expr, this.#updatePos);
        this.#update = expr ?? undefined;
      } else {
        this.#update = undefined;
      }
    }
    return this.#update;
  }
  set update(v) {
    this.#update = v ?? undefined;
  }
}
var CASE_TERMINATORS = {
  [Token.DoubleSemi]: ";;",
  [Token.SemiAmp]: ";&",
  [Token.DoubleSemiAmp]: ";;&"
};
var REDIRECT_OPS = {
  ">": ">",
  ">>": ">>",
  "<": "<",
  "<<": "<<",
  "<<-": "<<-",
  "<<<": "<<<",
  "<>": "<>",
  "<&": "<&",
  ">&": ">&",
  ">|": ">|",
  "&>": "&>",
  "&>>": "&>>"
};
function offsetArith(node, base) {
  node.pos += base;
  node.end += base;
  switch (node.type) {
    case "ArithmeticBinary":
      offsetArith(node.left, base);
      offsetArith(node.right, base);
      break;
    case "ArithmeticUnary":
      offsetArith(node.operand, base);
      break;
    case "ArithmeticTernary":
      offsetArith(node.test, base);
      offsetArith(node.consequent, base);
      offsetArith(node.alternate, base);
      break;
    case "ArithmeticGroup":
      offsetArith(node.expression, base);
      break;
  }
}
var listTerminators = new Uint8Array(37);
listTerminators[Token.EOF] = 1;
listTerminators[Token.RParen] = 1;
listTerminators[Token.RBrace] = 1;
listTerminators[Token.Then] = 1;
listTerminators[Token.Else] = 1;
listTerminators[Token.Elif] = 1;
listTerminators[Token.Fi] = 1;
listTerminators[Token.Do] = 1;
listTerminators[Token.Done] = 1;
listTerminators[Token.Esac] = 1;
listTerminators[Token.DoubleSemi] = 1;
listTerminators[Token.SemiAmp] = 1;
listTerminators[Token.DoubleSemiAmp] = 1;
var commandStarts = new Uint8Array(37);
commandStarts[Token.Word] = 1;
commandStarts[Token.Assignment] = 1;
commandStarts[Token.Bang] = 1;
commandStarts[Token.LParen] = 1;
commandStarts[Token.LBrace] = 1;
commandStarts[Token.DblLBracket] = 1;
commandStarts[Token.If] = 1;
commandStarts[Token.For] = 1;
commandStarts[Token.While] = 1;
commandStarts[Token.Until] = 1;
commandStarts[Token.Case] = 1;
commandStarts[Token.Function] = 1;
commandStarts[Token.Select] = 1;
commandStarts[Token.ArithCmd] = 1;
commandStarts[Token.Coproc] = 1;
commandStarts[Token.Redirect] = 1;
var UNARY_TEST_OPS = {
  "-a": 1,
  "-b": 1,
  "-c": 1,
  "-d": 1,
  "-e": 1,
  "-f": 1,
  "-g": 1,
  "-h": 1,
  "-k": 1,
  "-p": 1,
  "-r": 1,
  "-s": 1,
  "-t": 1,
  "-u": 1,
  "-v": 1,
  "-w": 1,
  "-x": 1,
  "-z": 1,
  "-n": 1,
  "-N": 1,
  "-S": 1,
  "-L": 1,
  "-G": 1,
  "-O": 1,
  "-R": 1
};
var BINARY_TEST_OPS = {
  "==": 1,
  "!=": 1,
  "=~": 1,
  "=": 1,
  "-eq": 1,
  "-ne": 1,
  "-lt": 1,
  "-le": 1,
  "-gt": 1,
  "-ge": 1,
  "-nt": 1,
  "-ot": 1,
  "-ef": 1,
  "<": 1,
  ">": 1
};
var EMPTY_PREFIX = [];
var EMPTY_SUFFIX = [];
var EMPTY_REDIRECTS = [];
function parse(source) {
  const parser = new Parser(source);
  return parser.parse(source.length);
}

class Parser {
  tok;
  source;
  errors = [];
  _redirects = [];
  constructor(source) {
    this.tok = new Lexer(source);
    this.source = source;
  }
  parse(sourceLen) {
    let shebang;
    if (this.source.charCodeAt(0) === 35 && this.source.charCodeAt(1) === 33) {
      const nl = this.source.indexOf(`
`);
      shebang = nl === -1 ? this.source : this.source.slice(0, nl);
    }
    const commands = this.list();
    const lexerErrors = this.tok._errors;
    if (lexerErrors !== null) {
      for (let i = 0;i < lexerErrors.length; i++)
        this.errors.push(lexerErrors[i]);
    }
    const result = {
      type: "Script",
      pos: 0,
      end: sourceLen,
      shebang,
      commands,
      errors: this.errors.length > 0 ? this.errors : undefined
    };
    return result;
  }
  error(message, pos) {
    this.errors.push({ message, pos });
  }
  skipSemi() {
    if (this.tok.peek(LexContext.Normal).token === Token.Semi)
      this.tok.next(LexContext.Normal);
  }
  accept(token, ctx = LexContext.Normal) {
    if (this.tok.peek(ctx).token === token)
      return this.tok.next(ctx);
    return null;
  }
  acceptEnd(token, ctx = LexContext.Normal) {
    if (this.tok.peek(ctx).token === token)
      return this.tok.next(ctx).end;
    return -1;
  }
  skipNewlines(ctx = LexContext.Normal) {
    while (this.tok.peek(ctx).token === Token.Newline)
      this.tok.next(ctx);
  }
  makeStatement(command, redirects) {
    const end = redirects.length > 0 ? redirects[redirects.length - 1].end : command.end;
    return {
      type: "Statement",
      pos: command.pos,
      end,
      command,
      background: undefined,
      redirects
    };
  }
  list() {
    const commands = [];
    this.skipNewlines(LexContext.CommandStart);
    let t = this.tok.peek(LexContext.CommandStart).token;
    if (listTerminators[t] || !commandStarts[t])
      return commands;
    const first = this.andOr();
    if (first) {
      const redirects = this._redirects;
      this._redirects = [];
      commands.push(this.makeStatement(first, redirects));
    }
    for (;; ) {
      t = this.tok.peek(LexContext.Normal).token;
      if (t !== Token.Semi && t !== Token.Newline && t !== Token.Amp)
        break;
      const isBackground = t === Token.Amp;
      const sepEnd = this.tok.next(LexContext.Normal).end;
      if (isBackground) {
        const stmt = commands[commands.length - 1];
        stmt.background = true;
        stmt.end = sepEnd;
      }
      this.skipNewlines(LexContext.CommandStart);
      t = this.tok.peek(LexContext.CommandStart).token;
      if (listTerminators[t] || !commandStarts[t])
        break;
      const node = this.andOr();
      if (node) {
        const redirects = this._redirects;
        this._redirects = [];
        commands.push(this.makeStatement(node, redirects));
      }
    }
    return commands;
  }
  andOr() {
    const first = this.pipeline();
    if (!first)
      return null;
    let t = this.tok.peek(LexContext.Normal).token;
    if (t !== Token.And && t !== Token.Or)
      return first;
    let wrappedFirst = first;
    if (this._redirects.length > 0) {
      wrappedFirst = this.makeStatement(first, this._redirects);
      this._redirects = [];
    }
    const commands = [wrappedFirst];
    const operators = [];
    do {
      operators.push(this.tok.next(LexContext.Normal).token === Token.And ? "&&" : "||");
      this.skipNewlines(LexContext.CommandStart);
      const next = this.pipeline();
      if (!next)
        break;
      commands.push(next);
      t = this.tok.peek(LexContext.Normal).token;
    } while (t === Token.And || t === Token.Or);
    return {
      type: "AndOr",
      pos: first.pos,
      end: commands[commands.length - 1].end,
      commands,
      operators
    };
  }
  wrapCompoundRedirects(node) {
    const redirects = this._redirects;
    this._redirects = [];
    if (redirects.length === 0)
      return node;
    return this.makeStatement(node, redirects);
  }
  pipeline() {
    let time = false;
    let pipelinePos = 0;
    if (this.tok.peek(LexContext.CommandStart).token === Token.Word && this.tok.peek(LexContext.CommandStart).value === "time") {
      time = true;
      pipelinePos = this.tok.next(LexContext.CommandStart).pos;
      if (this.tok.peek(LexContext.CommandStart).token === Token.Word && this.tok.peek(LexContext.CommandStart).value === "-p")
        this.tok.next(LexContext.CommandStart);
    }
    const negated = this.tok.peek(LexContext.CommandStart).token === Token.Bang;
    if (negated) {
      if (!time)
        pipelinePos = this.tok.peek(LexContext.CommandStart).pos;
      this.tok.next(LexContext.CommandStart);
    }
    const first = this.command();
    if (!first) {
      if (time || negated) {
        const pipeline2 = {
          type: "Pipeline",
          pos: pipelinePos,
          end: pipelinePos,
          commands: [],
          negated: negated ? true : undefined,
          operators: [],
          time: time ? true : undefined
        };
        return pipeline2;
      }
      return null;
    }
    if (!time && !negated)
      pipelinePos = first.pos;
    const commands = [first];
    const operators = [];
    let firstRedirects = this._redirects;
    this._redirects = [];
    while (this.tok.peek(LexContext.Normal).token === Token.Pipe) {
      if (commands.length === 1 && firstRedirects.length > 0) {
        commands[0] = this.makeStatement(first, firstRedirects);
        firstRedirects = [];
      }
      const pipeVal = this.tok.next(LexContext.Normal).value;
      operators.push(pipeVal === "|&" ? "|&" : "|");
      this.skipNewlines(LexContext.CommandStart);
      const cmd = this.command();
      if (cmd)
        commands.push(this.wrapCompoundRedirects(cmd));
    }
    if (commands.length === 1 && !negated && !time) {
      this._redirects = firstRedirects;
      return commands[0];
    }
    if (firstRedirects.length > 0) {
      commands[0] = this.makeStatement(first, firstRedirects);
    }
    const pipeline = {
      type: "Pipeline",
      pos: pipelinePos,
      end: commands[commands.length - 1].end,
      commands,
      negated: negated ? true : undefined,
      operators,
      time: time ? true : undefined
    };
    return pipeline;
  }
  command() {
    switch (this.tok.peek(LexContext.CommandStart).token) {
      case Token.LParen:
        return this.subshell();
      case Token.LBrace:
        return this.braceGroup();
      case Token.If:
        return this.ifClause();
      case Token.For:
        return this.forClause();
      case Token.While:
        return this.whileClause();
      case Token.Until:
        return this.untilClause();
      case Token.Case:
        return this.caseClause();
      case Token.Function:
        return this.functionDef();
      case Token.Select:
        return this.selectClause();
      case Token.DblLBracket:
        return this.testCommand();
      case Token.ArithCmd:
        return this.arithCommand();
      case Token.Coproc:
        return this.coprocCommand();
      case Token.Word:
      case Token.Assignment:
      case Token.Redirect:
        return this.simpleCommandOrFunction();
      default:
        return null;
    }
  }
  collectTrailingRedirects() {
    let redirects = [];
    while (this.tok.peek(LexContext.Normal).token === Token.Redirect) {
      redirects = this.collectRedirect(redirects, LexContext.Normal);
    }
    return redirects;
  }
  arithCommand() {
    const tok = this.tok.next(LexContext.CommandStart);
    this._redirects = this.collectTrailingRedirects();
    return new ArithmeticCommandImpl(tok.pos, tok.end, tok.value);
  }
  coprocCommand() {
    const startTok = this.tok.next(LexContext.CommandStart);
    const pos = startTok.pos;
    const startEnd = startTok.end;
    const t = this.tok.peek(LexContext.CommandStart);
    if (t.token !== Token.Word && t.token !== Token.Assignment && t.token !== Token.Redirect) {
      const body2 = this.pipeline() ?? {
        type: "Command",
        pos,
        end: startEnd,
        name: undefined,
        prefix: EMPTY_PREFIX,
        suffix: EMPTY_SUFFIX,
        redirects: EMPTY_REDIRECTS
      };
      const bodyRedirects2 = this._redirects;
      this._redirects = [];
      const redirects2 = this.collectTrailingRedirects();
      const allRedirects2 = [...bodyRedirects2, ...redirects2];
      const end2 = allRedirects2.length > 0 ? allRedirects2[allRedirects2.length - 1].end : body2.end;
      return { type: "Coproc", pos, end: end2, name: undefined, body: body2, redirects: allRedirects2 };
    }
    const tentativeWord = this.toWord(this.tok.next(LexContext.CommandStart));
    const body = this.pipeline();
    if (body === null) {
      const cmd = {
        type: "Command",
        pos: tentativeWord.pos,
        end: tentativeWord.end,
        name: tentativeWord,
        prefix: EMPTY_PREFIX,
        suffix: EMPTY_SUFFIX,
        redirects: EMPTY_REDIRECTS
      };
      const redirects2 = this.collectTrailingRedirects();
      const end2 = redirects2.length > 0 ? redirects2[redirects2.length - 1].end : cmd.end;
      return { type: "Coproc", pos, end: end2, name: undefined, body: cmd, redirects: redirects2 };
    }
    if (body.type === "Command") {
      const cmd = body;
      if (cmd.name) {
        cmd.suffix = [cmd.name, ...cmd.suffix];
      }
      cmd.name = tentativeWord;
      cmd.pos = tentativeWord.pos;
      const redirects2 = this.collectTrailingRedirects();
      const end2 = redirects2.length > 0 ? redirects2[redirects2.length - 1].end : cmd.end;
      return { type: "Coproc", pos, end: end2, name: undefined, body: cmd, redirects: redirects2 };
    }
    const bodyRedirects = this._redirects;
    this._redirects = [];
    const redirects = this.collectTrailingRedirects();
    const allRedirects = [...bodyRedirects, ...redirects];
    const end = allRedirects.length > 0 ? allRedirects[allRedirects.length - 1].end : body.end;
    return { type: "Coproc", pos, end, name: tentativeWord, body, redirects: allRedirects };
  }
  subshell() {
    const pos = this.tok.next(LexContext.CommandStart).pos;
    const commands = this.list();
    const closeEnd = this.acceptEnd(Token.RParen, LexContext.Normal);
    if (closeEnd < 0)
      this.error("expected ')' to close subshell", this.tok.getPos());
    const end = closeEnd >= 0 ? closeEnd : pos;
    this._redirects = this.collectTrailingRedirects();
    return { type: "Subshell", pos, end, body: this.makeCompoundList(commands) };
  }
  braceGroup() {
    const pos = this.tok.next(LexContext.CommandStart).pos;
    const commands = this.list();
    const closeEnd = this.acceptEnd(Token.RBrace, LexContext.Normal);
    if (closeEnd < 0)
      this.error("expected '}' to close brace group", this.tok.getPos());
    const end = closeEnd >= 0 ? closeEnd : pos;
    this._redirects = this.collectTrailingRedirects();
    return { type: "BraceGroup", pos, end, body: this.makeCompoundList(commands) };
  }
  ifClause() {
    const pos = this.tok.next(LexContext.CommandStart).pos;
    const clause = this.makeCompoundList(this.list());
    this.skipSemi();
    if (!this.accept(Token.Then, LexContext.CommandStart))
      this.error("expected 'then'", this.tok.getPos());
    const then_ = this.makeCompoundList(this.list());
    this.skipSemi();
    let else_;
    let end;
    if (this.tok.peek(LexContext.CommandStart).token === Token.Elif) {
      else_ = this.ifClause();
      end = else_.end;
    } else if (this.accept(Token.Else, LexContext.CommandStart)) {
      else_ = this.makeCompoundList(this.list());
      this.skipSemi();
      const closeEnd = this.acceptEnd(Token.Fi, LexContext.CommandStart);
      if (closeEnd < 0)
        this.error("expected 'fi' to close 'if'", this.tok.getPos());
      end = closeEnd >= 0 ? closeEnd : pos;
    } else {
      const closeEnd = this.acceptEnd(Token.Fi, LexContext.CommandStart);
      if (closeEnd < 0)
        this.error("expected 'fi' to close 'if'", this.tok.getPos());
      end = closeEnd >= 0 ? closeEnd : pos;
    }
    this._redirects = this.collectTrailingRedirects();
    return { type: "If", pos, end, clause, then: then_, else: else_ };
  }
  forClause() {
    const pos = this.tok.next(LexContext.CommandStart).pos;
    if (this.tok.peek(LexContext.Normal).token === Token.LParen) {
      return this.cStyleFor(pos);
    }
    const name = this.readWord(LexContext.Normal);
    const wordlist = [];
    this.skipNewlines(LexContext.CommandStart);
    if (this.tok.peek(LexContext.CommandStart).token === Token.In) {
      this.tok.next(LexContext.CommandStart);
      while (this.tok.peek(LexContext.Normal).token === Token.Word) {
        wordlist.push(this.readWord(LexContext.Normal));
      }
    }
    this.skipSemi();
    this.skipNewlines(LexContext.CommandStart);
    if (!this.accept(Token.Do, LexContext.CommandStart))
      this.error("expected 'do'", this.tok.getPos());
    const body = this.list();
    this.skipSemi();
    const closeEnd = this.acceptEnd(Token.Done, LexContext.CommandStart);
    if (closeEnd < 0)
      this.error("expected 'done' to close 'for'", this.tok.getPos());
    const end = closeEnd >= 0 ? closeEnd : pos;
    this._redirects = this.collectTrailingRedirects();
    return { type: "For", pos, end, name, wordlist, body: this.makeCompoundList(body) };
  }
  cStyleFor(pos) {
    const [initStr, testStr, updateStr, initPos, testPos, updatePos] = this.tok.readCStyleForExprs();
    if (this.tok.peek(LexContext.CommandStart).token === Token.Semi)
      this.tok.next(LexContext.CommandStart);
    this.skipNewlines(LexContext.CommandStart);
    if (this.tok.peek(LexContext.CommandStart).token === Token.LBrace) {
      const bg = this.braceGroup();
      return new ArithmeticForImpl(pos, bg.end, bg.body, initStr, testStr, updateStr, initPos, testPos, updatePos);
    }
    if (!this.accept(Token.Do, LexContext.CommandStart))
      this.error("expected 'do'", this.tok.getPos());
    const body = this.list();
    const closeEnd = this.acceptEnd(Token.Done, LexContext.CommandStart);
    if (closeEnd < 0)
      this.error("expected 'done' to close 'for'", this.tok.getPos());
    const end = closeEnd >= 0 ? closeEnd : pos;
    this._redirects = this.collectTrailingRedirects();
    return new ArithmeticForImpl(pos, end, this.makeCompoundList(body), initStr, testStr, updateStr, initPos, testPos, updatePos);
  }
  whileClause() {
    return this.whileOrUntil("while");
  }
  untilClause() {
    return this.whileOrUntil("until");
  }
  whileOrUntil(kind) {
    const pos = this.tok.next(LexContext.CommandStart).pos;
    const clause = this.makeCompoundList(this.list());
    this.skipSemi();
    if (!this.accept(Token.Do, LexContext.CommandStart))
      this.error("expected 'do'", this.tok.getPos());
    const body = this.list();
    this.skipSemi();
    const closeEnd = this.acceptEnd(Token.Done, LexContext.CommandStart);
    if (closeEnd < 0)
      this.error(`expected 'done' to close '${kind}'`, this.tok.getPos());
    const end = closeEnd >= 0 ? closeEnd : pos;
    this._redirects = this.collectTrailingRedirects();
    return { type: "While", pos, end, kind, clause, body: this.makeCompoundList(body) };
  }
  caseClause() {
    const pos = this.tok.next(LexContext.CommandStart).pos;
    const word = this.readWord(LexContext.Normal);
    this.skipNewlines(LexContext.CommandStart);
    if (!this.accept(Token.In, LexContext.CommandStart))
      this.error("expected 'in' after 'case' word", this.tok.getPos());
    this.skipNewlines(LexContext.CommandStart);
    const items = [];
    let t = this.tok.peek(LexContext.CommandStart).token;
    while (t !== Token.Esac && t !== Token.EOF) {
      const itemPos = this.tok.peek(LexContext.Normal).pos;
      this.accept(Token.LParen, LexContext.Normal);
      const pattern = [];
      t = this.tok.peek(LexContext.Normal).token;
      while (t !== Token.RParen && t !== Token.EOF) {
        if (t !== Token.Pipe)
          pattern.push(this.toWord(this.tok.next(LexContext.Normal)));
        else
          this.tok.next(LexContext.Normal);
        t = this.tok.peek(LexContext.Normal).token;
      }
      const rparenEnd = this.acceptEnd(Token.RParen, LexContext.Normal);
      const cmds = this.list();
      let itemEnd = rparenEnd >= 0 ? rparenEnd : itemPos;
      if (cmds.length > 0)
        itemEnd = cmds[cmds.length - 1].end;
      const item = {
        type: "CaseItem",
        pos: itemPos,
        end: itemEnd,
        pattern,
        body: this.makeCompoundList(cmds),
        terminator: undefined
      };
      t = this.tok.peek(LexContext.CommandStart).token;
      if (t === Token.DoubleSemi || t === Token.SemiAmp || t === Token.DoubleSemiAmp) {
        const termTok = this.tok.next(LexContext.CommandStart);
        item.terminator = CASE_TERMINATORS[termTok.token];
        item.end = termTok.end;
      }
      items.push(item);
      this.skipNewlines(LexContext.CommandStart);
      t = this.tok.peek(LexContext.CommandStart).token;
    }
    const closeEnd = this.acceptEnd(Token.Esac, LexContext.CommandStart);
    if (closeEnd < 0)
      this.error("expected 'esac' to close 'case'", this.tok.getPos());
    const end = closeEnd >= 0 ? closeEnd : pos;
    this._redirects = this.collectTrailingRedirects();
    return { type: "Case", pos, end, word, items };
  }
  selectClause() {
    const pos = this.tok.next(LexContext.CommandStart).pos;
    const name = this.readWord(LexContext.Normal);
    const wordlist = [];
    this.skipNewlines(LexContext.CommandStart);
    if (this.tok.peek(LexContext.CommandStart).token === Token.In) {
      this.tok.next(LexContext.CommandStart);
      while (this.tok.peek(LexContext.Normal).token === Token.Word) {
        wordlist.push(this.readWord(LexContext.Normal));
      }
    }
    this.skipSemi();
    this.skipNewlines(LexContext.CommandStart);
    if (!this.accept(Token.Do, LexContext.CommandStart))
      this.error("expected 'do'", this.tok.getPos());
    const body = this.list();
    this.skipSemi();
    const closeEnd = this.acceptEnd(Token.Done, LexContext.CommandStart);
    if (closeEnd < 0)
      this.error("expected 'done' to close 'select'", this.tok.getPos());
    const end = closeEnd >= 0 ? closeEnd : pos;
    this._redirects = this.collectTrailingRedirects();
    return { type: "Select", pos, end, name, wordlist, body: this.makeCompoundList(body) };
  }
  testCommand() {
    const pos = this.tok.next(LexContext.CommandStart).pos;
    const expr = this.parseTestOr();
    const closeEnd = this.acceptEnd(Token.DblRBracket, LexContext.TestMode);
    if (closeEnd < 0 && this.tok.peek(LexContext.Normal).token === Token.EOF)
      this.error("expected ']]' to close '[['", this.tok.getPos());
    const end = closeEnd >= 0 ? closeEnd : pos;
    this._redirects = this.collectTrailingRedirects();
    return { type: "TestCommand", pos, end, expression: expr };
  }
  parseTestOr() {
    let left = this.parseTestAnd();
    while (this.tok.peek(LexContext.TestMode).token === Token.Or) {
      this.tok.next(LexContext.TestMode);
      const right = this.parseTestAnd();
      left = {
        type: "TestLogical",
        pos: left.pos,
        end: right.end,
        operator: "||",
        left,
        right
      };
    }
    return left;
  }
  parseTestAnd() {
    let left = this.parseTestNot();
    while (this.tok.peek(LexContext.TestMode).token === Token.And) {
      this.tok.next(LexContext.TestMode);
      const right = this.parseTestNot();
      left = {
        type: "TestLogical",
        pos: left.pos,
        end: right.end,
        operator: "&&",
        left,
        right
      };
    }
    return left;
  }
  parseTestNot() {
    if (this.tok.peek(LexContext.TestMode).token === Token.Word && this.tok.peek(LexContext.TestMode).value === "!") {
      const notPos = this.tok.next(LexContext.TestMode).pos;
      const operand = this.parseTestNot();
      return { type: "TestNot", pos: notPos, end: operand.end, operand };
    }
    return this.parseTestPrimary();
  }
  parseTestPrimary() {
    if (this.tok.peek(LexContext.TestMode).token === Token.LParen) {
      const openPos = this.tok.next(LexContext.TestMode).pos;
      const expr = this.parseTestOr();
      const closeEnd = this.acceptEnd(Token.RParen, LexContext.TestMode);
      if (closeEnd < 0)
        this.error("expected ')' to close test group", this.tok.getPos());
      const end = closeEnd >= 0 ? closeEnd : openPos;
      return { type: "TestGroup", pos: openPos, end, expression: expr };
    }
    const first = this.tok.next(LexContext.TestMode);
    const val = first.value;
    const firstPos = first.pos;
    const firstEnd = first.end;
    if (UNARY_TEST_OPS[val] === 1) {
      const nt2 = this.tok.peek(LexContext.TestMode).token;
      if (nt2 === Token.Word) {
        const operand = this.readWord(LexContext.TestMode);
        return {
          type: "TestUnary",
          pos: firstPos,
          end: operand.end,
          operator: val,
          operand
        };
      }
    }
    const nt = this.tok.peek(LexContext.TestMode);
    if (nt.token === Token.Word && BINARY_TEST_OPS[nt.value] === 1) {
      const op = this.tok.next(LexContext.TestMode).value;
      let right;
      if (op === "=~") {
        right = this.toWord(this.tok.readTestRegexWord());
      } else {
        right = this.readWord(LexContext.TestMode);
      }
      const left = this.toWordFromPosEnd(first, firstPos, firstEnd);
      return {
        type: "TestBinary",
        pos: firstPos,
        end: right.end,
        operator: op,
        left,
        right
      };
    }
    const w = this.toWordFromPosEnd(first, firstPos, firstEnd);
    return { type: "TestUnary", pos: firstPos, end: w.end, operator: "-n", operand: w };
  }
  functionDef() {
    const pos = this.tok.next(LexContext.CommandStart).pos;
    const name = this.readWord(LexContext.Normal);
    if (this.tok.peek(LexContext.CommandStart).token === Token.LParen) {
      this.tok.next(LexContext.CommandStart);
      if (!this.accept(Token.RParen, LexContext.CommandStart))
        this.error("expected ')' after '('", this.tok.getPos());
    }
    this.skipNewlines(LexContext.CommandStart);
    const body = this.commandAsBody();
    const redirects = this._redirects;
    this._redirects = [];
    const end = redirects.length > 0 ? redirects[redirects.length - 1].end : body.end;
    return { type: "Function", pos, end, name, body, redirects };
  }
  simpleCommandOrFunction() {
    const prefix = [];
    let redirects = [];
    let cmdPos = this.tok.peek(LexContext.CommandStart).pos;
    let lastEnd = cmdPos;
    while (this.tok.peek(LexContext.CommandStart).token === Token.Assignment) {
      const t = this.tok.next(LexContext.CommandStart);
      lastEnd = t.end;
      prefix.push(this.parseAssignment(t));
    }
    while (this.tok.peek(LexContext.CommandStart).token === Token.Redirect) {
      redirects = this.collectRedirect(redirects, LexContext.CommandStart);
      lastEnd = redirects[redirects.length - 1].end;
    }
    if (this.tok.peek(LexContext.Normal).token !== Token.Word) {
      if (prefix.length > 0) {
        return {
          type: "Command",
          pos: cmdPos,
          end: lastEnd,
          name: undefined,
          prefix,
          suffix: EMPTY_SUFFIX,
          redirects
        };
      }
      return {
        type: "Command",
        pos: cmdPos,
        end: lastEnd,
        name: undefined,
        prefix: EMPTY_PREFIX,
        suffix: EMPTY_SUFFIX,
        redirects: EMPTY_REDIRECTS
      };
    }
    const name = this.readWord(LexContext.Normal);
    lastEnd = name.end;
    if (this.tok.peek(LexContext.Normal).token === Token.LParen) {
      this.tok.next(LexContext.Normal);
      if (this.tok.peek(LexContext.Normal).token === Token.RParen) {
        this.tok.next(LexContext.Normal);
        this.skipNewlines(LexContext.CommandStart);
        const body = this.commandAsBody();
        const bodyRedirects = this._redirects;
        this._redirects = [];
        const end = bodyRedirects.length > 0 ? bodyRedirects[bodyRedirects.length - 1].end : body.end;
        return { type: "Function", pos: name.pos, end, name, body, redirects: bodyRedirects };
      }
    }
    const suffix = [];
    for (;; ) {
      const st = this.tok.peek(LexContext.Normal).token;
      if (st === Token.Word || st === Token.Assignment) {
        const w = this.readWord(LexContext.Normal);
        suffix.push(w);
        lastEnd = w.end;
      } else if (st === Token.Redirect) {
        redirects = this.collectRedirect(redirects, LexContext.Normal);
        lastEnd = redirects[redirects.length - 1].end;
      } else {
        break;
      }
    }
    return { type: "Command", pos: cmdPos, end: lastEnd, name, prefix, suffix, redirects };
  }
  collectRedirect(redirects, ctx) {
    const t = this.tok.next(ctx);
    const tPos = t.pos;
    const tEnd = t.end;
    const r = {
      pos: tPos,
      end: tEnd,
      operator: REDIRECT_OPS[t.value] ?? ">",
      target: undefined,
      fileDescriptor: t.fileDescriptor,
      variableName: t.variableName,
      content: t.content,
      heredocQuoted: undefined,
      body: undefined
    };
    if (t.content != null) {
      r.target = new WordImpl(t.content, t.targetPos, t.targetEnd, this.source);
    }
    if (t.value === "<<" || t.value === "<<-")
      this.tok.registerHereDocTarget(r);
    redirects.push(r);
    return redirects;
  }
  commandAsBody() {
    const t = this.tok.peek(LexContext.CommandStart).token;
    if (t === Token.LBrace)
      return this.braceGroup();
    if (t === Token.LParen)
      return this.subshell();
    const cmd = this.command();
    const p = this.tok.getPos();
    return cmd ?? { type: "CompoundList", pos: p, end: p, commands: [] };
  }
  readWord(ctx) {
    return this.toWord(this.tok.next(ctx));
  }
  toWord(tok) {
    return new WordImpl(this.source.slice(tok.pos, tok.end), tok.pos, tok.end, this.source);
  }
  toWordFromPosEnd(tok, pos, end) {
    return new WordImpl(this.source.slice(pos, end), pos, end, this.source);
  }
  parseAssignment(tok) {
    const text = this.source.slice(tok.pos, tok.end);
    const tokPos = tok.pos;
    const tokEnd = tok.end;
    const result = {
      type: "Assignment",
      pos: tokPos,
      end: tokEnd,
      text,
      name: undefined,
      value: undefined,
      append: undefined,
      index: undefined,
      array: undefined
    };
    const eqIdx = text.indexOf("=");
    if (eqIdx <= 0)
      return result;
    let nameEnd = eqIdx;
    let append = false;
    let index;
    if (text.charCodeAt(eqIdx - 1) === 43) {
      append = true;
      nameEnd = eqIdx - 1;
    }
    const bracketIdx = text.indexOf("[");
    if (bracketIdx > 0 && bracketIdx < nameEnd) {
      const rbracketIdx = text.indexOf("]", bracketIdx);
      if (rbracketIdx > bracketIdx && rbracketIdx + 1 === nameEnd) {
        index = text.slice(bracketIdx + 1, rbracketIdx);
        nameEnd = bracketIdx;
      }
    }
    const name = text.slice(0, nameEnd);
    result.name = name;
    if (append)
      result.append = true;
    if (index !== undefined)
      result.index = index;
    const valStart = eqIdx + 1;
    const valText = text.slice(valStart);
    if (valText.charCodeAt(0) === 40 && valText.charCodeAt(valText.length - 1) === 41) {
      const inner = valText.slice(1, -1);
      const arrayOffset = tokPos + valStart + 1;
      const elements = this.parseArrayElements(inner, arrayOffset);
      result.array = elements;
    } else {
      result.value = new WordImpl(valText, tokPos + valStart, tokEnd, this.source);
    }
    return result;
  }
  parseArrayElements(inner, offset = 0) {
    const subTok = new Lexer(inner);
    const elements = [];
    while (subTok.peek(LexContext.Normal).token !== Token.EOF) {
      if (subTok.peek(LexContext.Normal).token === Token.Newline) {
        subTok.next(LexContext.Normal);
        continue;
      }
      const t = subTok.next(LexContext.Normal);
      if (t.token === Token.Word || t.token === Token.Assignment) {
        const pos = t.pos + offset;
        const end = t.end + offset;
        elements.push(new WordImpl(this.source.slice(pos, end), pos, end, this.source));
      }
    }
    return elements;
  }
  makeCompoundList(commands) {
    const p = this.tok.getPos();
    const pos = commands.length > 0 ? commands[0].pos : p;
    const end = commands.length > 0 ? commands[commands.length - 1].end : p;
    return { type: "CompoundList", pos, end, commands };
  }
}

// guards/block-destructive.ts
var HOME = homedir();
var SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
var WRAPPERS = new Set([
  "sudo",
  "env",
  "command",
  "builtin",
  "nohup",
  "time",
  "nice",
  "timeout",
  "gtimeout"
]);
var PROTECTED_HOME_DIRS = [
  "Documents",
  "Desktop",
  "Downloads",
  "Library",
  "Pictures",
  "Music",
  "Movies",
  ".ssh",
  ".gnupg",
  ".aws",
  ".kube",
  ".docker",
  ".1password",
  ".claude",
  ".codex",
  ".agents",
  ".gemini",
  ".cursor",
  ".nvm",
  ".cargo",
  ".npm",
  ".config"
];
var SAFE_PATH_PATTERNS = [
  /(?:^|\/)tmp(?:\/|$)/,
  /(?:^|\/)node_modules(?:\/|$)/,
  /(?:^|\/)\.next(?:\/|$)/,
  /(?:^|\/)dist(?:\/|$)/,
  /(?:^|\/)build(?:\/|$)/,
  /(?:^|\/)\.cache(?:\/|$)/,
  /(?:^|\/)out(?:\/|$)/,
  /(?:^|\/)coverage(?:\/|$)/,
  /(?:^|\/)\.turbo(?:\/|$)/,
  /(?:^|\/)__pycache__(?:\/|$)/,
  /(?:^|\/)\.pytest_cache(?:\/|$)/,
  /(?:^|\/)\.mypy_cache(?:\/|$)/,
  /(?:^|\/)storybook-static(?:\/|$)/,
  /(?:^|\/)\.claude\/discovery(?:\/|$)/,
  /(?:^|\/)\.agents\/skills(?:\/|$)/,
  /(?:^|\/)\.codex\/skills(?:\/|$)/
];
var DESTRUCTIVE_SQL = /(?:DROP\s+(?:TABLE|SCHEMA|DATABASE|VIEW|PROCEDURE|FUNCTION|OWNED|TRIGGER|INDEX)|TRUNCATE\s|DELETE\s+FROM)/i;
var DESTRUCTIVE_MONGO = /(?:\bdropDatabase\b|\.drop\s*\(|\.deleteMany\s*\(|\.remove\s*\()/i;
var SQL_CLIS = {
  psql: "PostgreSQL",
  mysql: "MySQL",
  duckdb: "DuckDB",
  sqlite3: "SQLite",
  sqlite: "SQLite"
};
var PLATFORM_DESTRUCTIVE = {
  render: new Set(["delete", "down", "destroy"]),
  railway: new Set(["delete", "down", "destroy", "remove"]),
  fly: new Set(["delete", "destroy"]),
  flyctl: new Set(["delete", "destroy"]),
  doctl: new Set(["delete", "destroy"])
};
function expandPath(p) {
  return p.replace(/^~(?=\/|$)/, HOME).replace(/^\$\{?HOME\}?(?=\/|$)/, HOME);
}
function normalizePath(p) {
  const expanded = expandPath(p);
  const resolved = pathResolve(expanded);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}
function isProtectedAbsolutePath(abs) {
  if (/^\/+$/.test(abs))
    return true;
  if (/^\/(?:usr|etc|System|private\/etc|bin|sbin|opt\/homebrew|var|Library|Applications)(?:\/|$)/.test(abs))
    return true;
  if (abs === HOME || abs === HOME + "/")
    return true;
  for (const dir of PROTECTED_HOME_DIRS) {
    const prefix = `${HOME}/${dir}`;
    if (abs === prefix || abs.startsWith(prefix + "/"))
      return true;
  }
  return false;
}
function isProtectedPath(p) {
  if (/^~\/?$/.test(p) || /^\$\{?HOME\}?\/?$/.test(p) || /^\/+$/.test(p))
    return true;
  if (/^~\/\*$/.test(p) || /^\$\{?HOME\}?\/\*$/.test(p))
    return true;
  if (/^\/\*/.test(p) || /^\.\.(?:\/|$)/.test(p))
    return true;
  return isProtectedAbsolutePath(normalizePath(p));
}
function isSafePath(p) {
  const normalized = normalizePath(p);
  return SAFE_PATH_PATTERNS.some((pat) => pat.test(normalized));
}
function walkCommandNodes(node, out = []) {
  if (!node)
    return out;
  if (node.type === "Command") {
    out.push(node);
    for (const s of node.suffix || []) {
      walkPartsForSubstitutions(s, out);
    }
    return out;
  }
  for (const child of node.commands || []) {
    walkCommandNodes(child, out);
  }
  if (node.body)
    walkCommandNodes(node.body, out);
  if (node.command)
    walkCommandNodes(node.command, out);
  if (node.then)
    walkCommandNodes(node.then, out);
  if (node.else)
    walkCommandNodes(node.else, out);
  if (node.condition)
    walkCommandNodes(node.condition, out);
  for (const clause of node.clauses || []) {
    walkCommandNodes(clause, out);
  }
  return out;
}
function walkPartsForSubstitutions(node, commands) {
  if (!node)
    return;
  if (node.type === "CommandSubstitution" || node.type === "Backtick") {
    commands.push(...walkCommandNodes(node.body || node.command));
  }
  for (const part of node.parts || []) {
    walkPartsForSubstitutions(part, commands);
  }
}
function resolveCommand(node) {
  if (!node.name)
    return null;
  let name = node.name.value || "";
  let args = (node.suffix || []).map((s) => s.value ?? s.text ?? "");
  name = name.replace(/^\/(?:usr\/(?:local\/)?)?(?:s?bin)\//, "");
  while (WRAPPERS.has(name) && args.length > 0) {
    let skip = 0;
    if (name === "sudo") {
      while (skip < args.length && args[skip].startsWith("-")) {
        if (["-u", "-g", "-C"].includes(args[skip]) && skip + 1 < args.length) {
          skip += 2;
        } else {
          skip += 1;
        }
      }
    } else if (name === "env") {
      while (skip < args.length && (args[skip].startsWith("-") || /^\w+=/.test(args[skip]))) {
        skip += 1;
      }
    } else if (name === "nice") {
      if (args[skip] === "-n" && skip + 1 < args.length)
        skip = 2;
    } else if (name === "timeout" || name === "gtimeout") {
      skip = 1;
    }
    if (skip >= args.length)
      break;
    name = args[skip].replace(/^\/(?:usr\/(?:local\/)?)?(?:s?bin)\//, "");
    args = args.slice(skip + 1);
  }
  const hasInputRedirect = (node.redirects || []).some((r) => ["<<", "<<<", "<<-"].includes(r.operator));
  const rawParts = [node.name.text || node.name.value, ...(node.suffix || []).map((s) => s.text || s.value)];
  return { name, args, raw: rawParts.join(" "), hasInputRedirect };
}
function extractCommands(command) {
  try {
    const ast = parse(command);
    const nodes = walkCommandNodes(ast);
    return nodes.map(resolveCommand).filter((c) => c !== null);
  } catch {
    return fallbackExtract(command);
  }
}
function fallbackExtract(command) {
  return command.split(/(?:;|&&|\|\||\||\n)\s*/).map((s) => s.trim()).filter(Boolean).map((seg) => {
    const normalized = normalizeCommandFallback(seg);
    const parts = normalized.split(/\s+/);
    return {
      name: parts[0] || "",
      args: parts.slice(1),
      raw: seg,
      hasInputRedirect: /<<<?\s/.test(seg)
    };
  });
}
function normalizeCommandFallback(s) {
  let prev = "";
  let curr = s;
  while (prev !== curr) {
    prev = curr;
    curr = curr.replace(/^sudo\s+/, "").replace(/^env(?:\s+(?:-\S+|\w+=\S+))*\s+/, "").replace(/^(?:command|builtin)\s+/, "").replace(/^\/(?:usr\/(?:local\/)?)?bin\//, "").replace(/^(?:nohup|time)\s+/, "").replace(/^nice(?:\s+-n\s+\S+)?\s+/, "").replace(/^(?:timeout|gtimeout)\s+\S+\s+/, "");
  }
  return curr;
}
function checkHardBlock(cmd) {
  if (cmd.name === "find") {
    for (let i = 0;i < cmd.args.length; i++) {
      if ((cmd.args[i] === "-exec" || cmd.args[i] === "-execdir") && (cmd.args[i + 1] === "rm" || cmd.args[i + 1] === "sudo")) {
        return "find -exec rm is not allowed. Use trash for file deletion.";
      }
    }
    if (cmd.args.includes("-delete")) {
      return "find -delete permanently deletes files. Use trash instead.";
    }
  }
  if (cmd.name === "xargs") {
    if (cmd.args[0] === "rm" || cmd.args[0] === "sudo" && cmd.args[1] === "rm") {
      return "xargs rm is not allowed. Use trash for file deletion.";
    }
  }
  if (SHELLS.has(cmd.name)) {
    if (cmd.args.includes("-c") || cmd.hasInputRedirect) {
      return "Shell inline execution (shell -c, here-strings) is not allowed. Run commands directly.";
    }
  }
  if (cmd.name === "eval")
    return "eval is not allowed. Run commands directly.";
  if (cmd.name === "unlink")
    return "unlink permanently deletes files. Use: trash <path>";
  if (cmd.name === "shred")
    return "shred permanently destroys file content. Use: trash <path>";
  if (cmd.name === "truncate")
    return "truncate destroys file content.";
  return null;
}
function checkGatedCommand(cmd) {
  const { name, args } = cmd;
  const sqlLabel = SQL_CLIS[name];
  if (sqlLabel && args.some((a) => DESTRUCTIVE_SQL.test(a))) {
    return `Destructive ${sqlLabel} SQL detected (DROP/TRUNCATE/DELETE).`;
  }
  if (name === "snow" && args[0] === "sql" && args.some((a) => DESTRUCTIVE_SQL.test(a))) {
    return "Destructive Snowflake SQL detected (DROP/TRUNCATE/DELETE).";
  }
  if ((name === "mongosh" || name === "mongo") && args.some((a) => DESTRUCTIVE_MONGO.test(a))) {
    return "Destructive MongoDB command detected (drop/deleteMany/remove).";
  }
  if (name === "redis-cli" && args.some((a) => /^(?:FLUSHDB|FLUSHALL)$/i.test(a))) {
    return "Destructive Redis command detected (FLUSHDB/FLUSHALL).";
  }
  if (name === "aws") {
    if (args[0] === "s3" && ["rm", "rb"].includes(args[1])) {
      return "Destructive AWS S3 command (rm/rb).";
    }
    if (args.length >= 2 && /^(?:terminate|delete)/.test(args[1] || "")) {
      return "Destructive AWS CLI command detected.";
    }
  }
  if (name === "gcloud" && args.includes("delete")) {
    return "Destructive gcloud command detected.";
  }
  if (name === "gsutil" && ["rm", "rb"].includes(args[0])) {
    return "Destructive gsutil command (rm/rb).";
  }
  if (name === "az" && args.includes("delete")) {
    return "Destructive Azure CLI command detected.";
  }
  if (name === "doctl" && args.some((a) => a === "delete" || a === "destroy")) {
    return "Destructive DigitalOcean CLI command detected.";
  }
  if (name === "terraform") {
    if (args[0] === "destroy")
      return "Destructive Terraform command (destroy).";
    if (args[0] === "apply" && args.includes("-auto-approve")) {
      return "Destructive Terraform command (apply -auto-approve).";
    }
  }
  if (name === "pulumi" && args[0] === "destroy")
    return "Pulumi destroy detected.";
  if (name === "cdk" && args[0] === "destroy")
    return "CDK destroy detected.";
  if (name === "kubectl" && ["delete", "drain", "cordon"].includes(args[0])) {
    return "Destructive kubectl command.";
  }
  if (name === "docker") {
    if (["rm", "rmi"].includes(args[0]))
      return "Destructive Docker command.";
    if (args[0] === "system" && args[1] === "prune")
      return "Destructive Docker command.";
    if (["volume", "container", "image"].includes(args[0]) && args[1] === "rm") {
      return "Destructive Docker command.";
    }
  }
  if (name === "helm" && ["uninstall", "delete"].includes(args[0])) {
    return "Destructive Helm command.";
  }
  const platformVerbs = PLATFORM_DESTRUCTIVE[name];
  if (platformVerbs && args.some((a) => platformVerbs.has(a))) {
    return `Destructive ${name} CLI command.`;
  }
  if (name === "heroku" && args.some((a) => a === "destroy" || a === "pg:reset" || a.includes(":destroy"))) {
    return "Destructive Heroku CLI command.";
  }
  if (name === "vercel" && ["remove", "rm"].includes(args[0])) {
    return "Destructive Vercel CLI command.";
  }
  if (name === "netlify" && args.some((a) => a === "sites:delete")) {
    return "Destructive Netlify CLI command.";
  }
  if (name === "supabase") {
    if (args.includes("delete"))
      return "Destructive Supabase CLI command.";
    if (args[0] === "db" && args[1] === "reset")
      return "Destructive Supabase CLI command.";
  }
  if (name === "gh" && args[0] === "repo" && args[1] === "delete") {
    return "Destructive GitHub CLI command (repo delete).";
  }
  if (name === "wrangler" && args.includes("delete")) {
    return "Destructive Cloudflare Wrangler command.";
  }
  if (name === "firebase" && args.some((a) => ["projects:delete", "firestore:delete", "hosting:disable"].includes(a))) {
    return "Destructive Firebase CLI command.";
  }
  if (name === "dbt" && ["run", "build"].includes(args[0]) && args.includes("--full-refresh")) {
    return "dbt --full-refresh drops and recreates tables.";
  }
  if (name === "dd" && args.some((a) => a.startsWith("if="))) {
    return "dd with input file \u2014 potential disk overwrite.";
  }
  return null;
}
function checkRm(cmd) {
  const flags = [];
  const paths = [];
  let endOfFlags = false;
  for (const arg of cmd.args) {
    if (arg === "--") {
      endOfFlags = true;
    } else if (!endOfFlags && arg.startsWith("-")) {
      flags.push(arg);
    } else {
      paths.push(arg);
    }
  }
  const isRecursive = flags.some((f) => /^-[^-]*r/i.test(f) || f === "--recursive");
  const isForce = flags.some((f) => /^-[^-]*f/.test(f) || f === "--force");
  if (paths.length === 0) {
    console.error(`BLOCKED: '${cmd.raw}' \u2014 rm requires an explicit path. Use: trash <path>`);
    process.exit(2);
  }
  const hasDangerousWildcard = paths.some((p) => {
    if (p === "*" || p === "." || p === "..")
      return true;
    if (isRecursive || isForce) {
      if (p === "./*" || p === "../*")
        return true;
    }
    return false;
  });
  if (hasDangerousWildcard) {
    console.error(`BLOCKED: '${cmd.raw}' \u2014 rm with bare wildcard/dot is not allowed. Be explicit about which paths to delete.`);
    process.exit(2);
  }
  for (const p of paths) {
    if (!isSafePath(p) && isProtectedPath(p)) {
      console.error(`BLOCKED: '${cmd.raw}' \u2014 '${p}' is a protected path.`);
      process.exit(2);
    }
  }
  const unsafePaths = paths.filter((p) => !isSafePath(p));
  if (unsafePaths.length > 0) {
    const trashCmd = `trash ${unsafePaths.join(" ")}`;
    console.error(`BLOCKED: rm is not allowed for non-ephemeral paths. Re-run your command using trash instead:

  ${trashCmd}

trash moves files to macOS Trash (recoverable). Ephemeral paths (tmp, node_modules, dist, build, .cache, coverage, __pycache__, etc.) are allowed with rm.`);
    process.exit(2);
  }
}
var GATE_DIR = "/tmp/.claude-destructive-gate";
function computeGateHash(command) {
  return createHash("sha256").update(command).digest("hex").slice(0, 16);
}
function consumeGateApproval(command) {
  const hash = computeGateHash(command);
  const approvalPath = `${GATE_DIR}/${hash}`;
  try {
    unlinkSync(approvalPath);
    return true;
  } catch {
    return false;
  }
}
function gateBlock(command, reason) {
  const hash = computeGateHash(command);
  console.error(`GATED: ${reason}

` + `This command requires explicit user approval before execution.
` + `1. Show the user the exact command and explain what it will do
` + `2. Ask for their explicit approval
` + `3. If approved, run: mkdir -p ${GATE_DIR} && echo approved > ${GATE_DIR}/${hash}
` + `4. Then retry the original command unchanged`);
  process.exit(2);
}
function main() {
  try {
    const rawInput = readFileSync(0, "utf-8");
    const input = JSON.parse(rawInput);
    const command = input.tool_input?.command || "";
    const commands = extractCommands(command);
    for (const cmd of commands) {
      const reason = checkHardBlock(cmd);
      if (reason) {
        console.error(`BLOCKED: ${reason}`);
        process.exit(2);
      }
    }
    const gateApproved = consumeGateApproval(command);
    if (!gateApproved) {
      for (const cmd of commands) {
        const reason = checkGatedCommand(cmd);
        if (reason) {
          gateBlock(command, reason);
        }
      }
    }
    for (const cmd of commands) {
      if (cmd.name === "rm") {
        checkRm(cmd);
      }
    }
    process.exit(0);
  } catch (error) {
    console.error("[block-destructive] Hook error (non-blocking):", error instanceof Error ? error.message : error);
    process.exit(0);
  }
}
main();
