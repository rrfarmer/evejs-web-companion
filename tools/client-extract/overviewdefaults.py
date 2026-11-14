"""The client's default overview profile, as JSON on stdout.

eve/client/script/parklife/overview/default/const.py: DEFAULT is 'jotunn_default', a YAML overview
(data/jotunn_default.py's JOTUNN_DEFAULT) - not the FSD defaultoverviews.fsdbinary, which is 'old_default'.
yamldefaultoverview.py _do_load: each preset of `presets` (a list of [shortName, [[key, value], ...]]) its
name the localized message of the number in "DefaultPreset_<nameID>", its category_id (CATEGORY_NONE 0 where
absent), groups, alwaysShownStates, filteredStates and description_id; `tabSetup` [[tabID, [[key, value], ...]]]
each tab's overview and bracket presets, named by YAML_OVERVIEWS['jotunn_default']['tab_name_ids'].

    python overviewdefaults.py [<decompiled client tree>]

The YAML is the block-sequence subset the profile uses (no PyYAML here): "- " items, nested "- - ", "[]",
null, integers and plain words.
"""
import ast
import json
import re
import sys
from pathlib import Path

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else r"C:/Users/Farmer/Documents/GitHub/EveOffline/tools/ClientCodeGrabber/Latest")
DEFAULT_DIR = ROOT / "eve/client/script/parklife/overview/default"


def scalar(text):
    text = text.strip()
    if text in ("", "null", "~"):
        return None
    if text == "[]":
        return []
    if re.fullmatch(r"-?\d+", text):
        return int(text)
    if text in ("true", "false"):
        return text == "true"
    return text


def parse_block(lines, start, indent):
    """A block sequence or mapping whose items sit at `indent`; returns (value, next line index)."""
    if start >= len(lines):
        return None, start
    first_indent, first = lines[start]
    if first.startswith("- ") or first == "-":
        items = []
        i = start
        while i < len(lines) and lines[i][0] == indent and (lines[i][1].startswith("- ") or lines[i][1] == "-"):
            value, i = parse_item(lines, i, indent)
            items.append(value)
        return items, i
    mapping = {}
    i = start
    while i < len(lines) and lines[i][0] == indent and not lines[i][1].startswith("- "):
        key, _, rest = lines[i][1].partition(":")
        i += 1
        if rest.strip():
            mapping[key] = scalar(rest)
        elif i < len(lines) and lines[i][0] >= indent and (lines[i][0] > indent or lines[i][1].startswith("- ")):
            mapping[key], i = parse_block(lines, i, lines[i][0])
        else:
            mapping[key] = None
    return mapping, i


def parse_item(lines, i, indent):
    """One "- ..." item at `indent`: its rest of line may itself open a nested "- " sequence."""
    text = lines[i][1]
    rest = text[1:].lstrip() if text != "-" else ""
    if not rest:
        if i + 1 < len(lines) and lines[i + 1][0] > indent:
            return parse_block(lines, i + 1, lines[i + 1][0])
        return None, i + 1
    if rest.startswith("- ") or rest == "-":
        # a nested sequence starting on this line: its items sit at indent + 2
        inner_indent = indent + 2
        lines[i] = (inner_indent, rest)
        return parse_block(lines, i, inner_indent)
    return scalar(rest), i + 1


def load_yaml(text):
    lines = []
    for raw in text.split("\n"):
        if not raw.strip():
            continue
        lines.append((len(raw) - len(raw.lstrip(" ")), raw.strip()))
    value, _ = parse_block(lines, 0, 0)
    return value


def pairs(items):
    return {entry[0]: entry[1] for entry in items or [] if isinstance(entry, list) and len(entry) == 2}


def main():
    source = (DEFAULT_DIR / "data/jotunn_default.py").read_text(encoding="utf-8")
    match = re.search(r'JOTUNN_DEFAULT = (".*?")\s*$', source, re.S)
    data = load_yaml(ast.literal_eval(match.group(1)))
    const = (DEFAULT_DIR / "const.py").read_text(encoding="utf-8")
    jotunn = re.search(r"'jotunn_default': \{.*?'default_preset': '([^']+)'.*?'tab_name_ids': \{([^}]*)\}", const, re.S)
    tab_name_ids = {int(k): int(v) for k, v in re.findall(r"(\d+):\s*(\d+)", jotunn.group(2))}
    presets = {}
    for short_name, settings in pairs(data["presets"]).items():
        fields = pairs(settings)
        name_id = int(short_name.replace("DefaultPreset_", "")) if "DefaultPreset" in short_name else None
        presets[short_name] = {
            "nameID": name_id,
            "categoryID": fields.get("category_id") or 0,
            "descriptionID": fields.get("description_id"),
            "groups": fields.get("groups") or [],
            "alwaysShownStates": fields.get("alwaysShownStates") or [],
            "filteredStates": fields.get("filteredStates") or [],
        }
    tabs = []
    for tab_id, settings in sorted(pairs(data["tabSetup"]).items()):
        fields = pairs(settings)
        tabs.append({"tabID": tab_id, "nameID": tab_name_ids.get(tab_id), "yamlName": fields.get("name"),
                     "overview": fields.get("overview"), "bracket": fields.get("bracket")})
    json.dump({"source": "jotunn_default", "defaultPreset": jotunn.group(1), "presets": presets, "tabs": tabs}, sys.stdout)


if __name__ == "__main__":
    main()
