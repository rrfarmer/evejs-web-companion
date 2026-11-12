"""The client's command list as its Shortcuts panel shows it, written to web/src/play/clientShortcuts.ts.

Reads the decompiled client (carbonui/services/command.py SetDefaultShortcutMappingCORE, eve/client/script/ui/
eveCommands.py SetDefaultShortcutMappingGAME): each CommandMapping's command, its default shortcut (the Windows keys:
k(win=..., mac=...) takes win, a darwin-only branch is skipped), its category (the "for cm in m: cm.category = ..."
after the list) and whether it is locked; the command's name label (labelsByFuncName, or the command's nameLabelPath).
The files are Python 2, so only those functions and the label dictionaries are cut out and parsed.

    python tools/client-extract/shortcuts.py <ClientCodeGrabber/Latest>
"""
import ast
import json
import re
import sys
import textwrap
from pathlib import Path

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else r"C:/Users/Farmer/Documents/GitHub/EveOffline/tools/ClientCodeGrabber/Latest")
CORE = ROOT / "carbonui/services/command.py"
GAME = ROOT / "eve/client/script/ui/eveCommands.py"
OUT = Path(__file__).resolve().parents[2] / "web/src/play/clientShortcuts.ts"

# GetKeyName: the Windows key name text (GetKeyNameText) for the keys the defaults use
KEY_NAMES = {
    "VK_CONTROL": "Ctrl", "VK_MENU": "Alt", "VK_SHIFT": "Shift", "VK_LWIN": "Win", "VK_SPACE": "Space", "VK_RETURN": "Enter",
    "VK_ESCAPE": "Esc", "VK_TAB": "Tab", "VK_UP": "Up", "VK_DOWN": "Down", "VK_LEFT": "Left", "VK_RIGHT": "Right",
    "VK_ADD": "Num +", "VK_SUBTRACT": "Num -", "VK_MULTIPLY": "Num *", "VK_DIVIDE": "Num /", "VK_SNAPSHOT": "Prnt Scrn",
    "VK_XBUTTON1": "Mouse 4", "VK_XBUTTON2": "Mouse 5", "VK_HOME": "Home", "VK_END": "End", "VK_PRIOR": "Page Up",
    "VK_NEXT": "Page Down", "VK_INSERT": "Insert", "VK_DELETE": "Delete", "VK_BACK": "Backspace", "VK_PAUSE": "Pause",
    "VK_OEM_PERIOD": ".", "VK_OEM_COMMA": ",", "VK_OEM_MINUS": "-", "VK_OEM_PLUS": "=", "VK_OEM_1": ";", "VK_OEM_2": "/",
    "VK_OEM_3": "`", "VK_OEM_4": "[", "VK_OEM_5": "\\", "VK_OEM_6": "]", "VK_OEM_7": "'",
}


def key_name(vk):
    if vk in KEY_NAMES:
        return KEY_NAMES[vk]
    m = re.fullmatch(r"VK_(F\d+|[A-Z0-9])", vk)
    if m:
        return m.group(1)
    m = re.fullmatch(r"VK_NUMPAD(\d)", vk)
    if m:
        return "Num " + m.group(1)
    raise ValueError(vk)


def cut_function(src, name):
    """The method's source, dedented (its body ends where the next def at its indent starts)."""
    m = re.search(r"^( *)def %s\(self\):\n" % name, src, re.M)
    indent = m.group(1)
    end = re.compile(r"^%s(def |@)" % indent, re.M).search(src, m.end())
    return textwrap.dedent(src[m.start():end.start() if end else len(src)])


def cut_dict(src, name):
    m = re.search(r"^%s = \{" % name, src, re.M)
    depth, i = 0, m.end() - 1
    while True:
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                break
        i += 1
    return ast.literal_eval(src[m.end() - 1:i + 1])


class Mapping:
    def __init__(self, cmd, keys, repeatable=False):
        self.cmd, self.keys, self.category, self.locked = cmd, keys, "general", False


def run(fn_src):
    tree = ast.parse(fn_src).body[0]
    out = []
    env = {"CTRL": ["VK_CONTROL"], "ALT": ["VK_MENU"], "SHIFT": ["VK_SHIFT"], "COMMAND": ["VK_LWIN"]}

    def keys_of(node, i):
        if isinstance(node, ast.Constant) and node.value is None:
            return None
        if isinstance(node, ast.Tuple):
            # (a key of None in the tuple is skipped, as GetStringFromShortcutKeys skips it)
            return [k for e in node.elts for k in (keys_of(e, i) or [])]
        if isinstance(node, ast.Name):
            return env[node.id]
        if isinstance(node, ast.Attribute):  # uiconst.VK_X
            return [node.attr]
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "k":
            win = next(kw.value for kw in node.keywords if kw.arg == "win")
            return keys_of(win, i)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "getattr":
            # getattr(uiconst, 'VK_F%s' % i)
            return [node.args[1].left.value % i]
        raise ValueError(ast.dump(node))

    def cmd_of(node, i):
        if isinstance(node, ast.Attribute):
            return node.attr
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "MakeCmdTagItem":
            # MakeCmdTagItem(tag): 'CmdTagItem_%s' % tag
            return "CmdTagItem_%s" % node.args[0].value
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "MakeCmdTagItemFromSequence":
            return "CmdTagItem_%s" % "".join(e.value for e in node.args[0].elts)
        if isinstance(node, ast.Call) and node.func.id == "getattr":
            return node.args[1].left.value % i
        raise ValueError(ast.dump(node))

    def mapping(call, i):
        assert isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and call.func.id == "c", ast.dump(call)
        keys = keys_of(call.args[1], i) if len(call.args) > 1 else None
        return Mapping(cmd_of(call.args[0], i), keys)

    def list_of(node, i):
        return [mapping(e, i) for e in node.elts]

    def walk(stmts, m, i=None):
        for st in stmts:
            if isinstance(st, ast.Assign) and isinstance(st.targets[0], ast.Name) and st.targets[0].id == "m":
                m[:] = list_of(st.value, i)
            elif isinstance(st, ast.Assign) and isinstance(st.targets[0], ast.Name) and st.targets[0].id in ("ret", "c") + tuple(env.keys()) and st.targets[0].id not in ("key",):
                pass
            elif isinstance(st, ast.Assign) and isinstance(st.targets[0], ast.Name):
                # a key named in the loop (key = getattr(uiconst, 'VK_F%s' % i))
                env[st.targets[0].id] = keys_of(st.value, i)
            elif isinstance(st, ast.Expr) and isinstance(st.value, ast.Call) and isinstance(st.value.func, ast.Attribute) \
                    and isinstance(st.value.func.value, ast.Name) and st.value.func.value.id == "m":
                if st.value.func.attr == "extend":
                    m.extend(list_of(st.value.args[0], i))
                elif st.value.func.attr == "append":
                    m.append(mapping(st.value.args[0], i))
            elif isinstance(st, ast.For) and isinstance(st.target, ast.Name) and st.target.id == "cm":
                # "for cm in m: cm.category = ...; cm.isLocked = True; ret.append(cm)"
                for s in st.body:
                    if isinstance(s, ast.Assign) and isinstance(s.targets[0], ast.Attribute):
                        for mm in m:
                            if s.targets[0].attr == "category":
                                mm.category = s.value.value
                            elif s.targets[0].attr == "isLocked":
                                mm.locked = bool(s.value.value)
                out.extend(m)
                m[:] = []
            elif isinstance(st, ast.For):
                it = st.iter
                if isinstance(it, ast.Call) and it.func.id in ("xrange", "range"):
                    lo, hi = (it.args[0].value, it.args[1].value) if len(it.args) == 2 else (0, it.args[0].value)
                    for v in range(lo, hi):
                        walk(st.body, m, v)
            elif isinstance(st, ast.If):
                # sys.platform.startswith('darwin'): the Windows branch
                test = ast.unparse(st.test)
                walk(st.orelse if "darwin" in test else st.body, m, i)
            elif isinstance(st, (ast.FunctionDef, ast.Return)):
                pass
        return m

    walk(tree.body, [])
    return out


core_src = CORE.read_text(encoding="utf-8")
game_src = GAME.read_text(encoding="utf-8")
labels = {**cut_dict(core_src, "labelsByFuncName"), **cut_dict(game_src, "labelsByFuncName")}
for name, path in re.findall(r"^\s+(\w+)\.nameLabelPath = '([^']+)'", game_src, re.M):
    labels.setdefault(name, path)
# "OpenAssets.nameLabelPath = AssetsWindow.default_captionLabelPath": the window class's caption, from its own source
captions = {}
for f in ROOT.rglob("*.py"):
    text = f.read_text(encoding="utf-8", errors="replace")
    if "default_captionLabelPath" not in text:
        continue
    # each top-level class's text, up to the next top-level statement
    for start in re.finditer(r"^class (\w+)", text, re.M):
        nxt = re.compile(r"^\S", re.M).search(text, start.end())
        body = text[start.end():nxt.start() if nxt else len(text)]
        m = re.search(r"^\s+default_captionLabelPath = '([^']+)'", body, re.M)
        if m:
            captions.setdefault(start.group(1), m.group(1))
for name, cls in re.findall(r"^\s+(\w+)\.nameLabelPath = (\w+)\.default_captionLabelPath", game_src, re.M):
    if cls in captions:
        labels.setdefault(name, captions[cls])
mappings = run(cut_function(core_src, "SetDefaultShortcutMappingCORE")) + run(cut_function(game_src, "SetDefaultShortcutMappingGAME"))
rows = [{"cmd": mm.cmd, "label": labels.get(mm.cmd), "keys": "-".join(key_name(k) for k in mm.keys) if mm.keys else "",
         "category": mm.category, **({"locked": True} if mm.locked else {})} for mm in mappings]
body = ",\n".join("  " + json.dumps(r, ensure_ascii=False) for r in rows)
OUT.write_text(f"""// Generated by tools/client-extract/shortcuts.py from the decompiled client (command.py SetDefaultShortcutMappingCORE,
// eveCommands.py SetDefaultShortcutMappingGAME): the commands the Shortcuts panel lists, their default (Windows)
// shortcuts, categories (systemMenuConst PANEL_IDS_SHORTCUTS) and name labels (labelsByFuncName / nameLabelPath).
// Do not edit by hand.

export interface ClientShortcut {{
  readonly cmd: string;
  readonly label: string | null;
  readonly keys: string;
  readonly category: string;
  readonly locked?: boolean;
}}

export const CLIENT_SHORTCUTS: readonly ClientShortcut[] = [
{body},
];
""", encoding="utf-8", newline="\n")
from collections import Counter
print(len(rows), dict(Counter(r["category"] for r in rows)), sum(1 for r in rows if not r["label"]), "without a label")
