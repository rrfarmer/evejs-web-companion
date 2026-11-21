# The Overview Settings Filters panel's category tree as the 3698585 client lists it (TabPresetPanel.GetListOfCategories),
# read from a running client with the settings window open (tactical.OpenSettings()):
#   node tools/gridcheck/bin/gridcheck.js client eval --json --file tools/client-extract/overviewFilterGroups.py
# The page reads it as _local/client-assets/<build>/overviewFilterGroups.json: {source, categories: <the result>}.
from carbonui.uicore import uicore
import evetypes
def find(node, name, depth=0):
    if getattr(node, 'name', None) == name:
        return node
    if depth > 30:
        return None
    for c in getattr(node, 'children', []) or []:
        r = find(c, name, depth + 1)
        if r is not None:
            return r
    return None
wnd = find(uicore.desktop, 'overviewsettings')
cats = wnd.tabPresetPanel.GetListOfCategories('')
out = []
for catName in sorted(cats.keys()):
    groups = []
    for groupID, name in cats[catName]:
        if isinstance(groupID, list):
            groups.append({'name': name, 'groupIDs': list(groupID)})
        else:
            groups.append({'name': evetypes.GetGroupNameByGroup(groupID), 'groupIDs': [groupID]})
    groups.sort(key=lambda g: g['name'].lower())
    out.append({'category': catName, 'groups': groups})
result = out
