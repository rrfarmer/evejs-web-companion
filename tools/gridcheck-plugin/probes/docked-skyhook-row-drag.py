# Read the installed Skyhook drag payload using the native scroll's selected-node order.
from carbonui.control.scroll import Scroll
from carbonui.util.bunch import Bunch
from eve.client.script.ui.structure.structureBrowser.entries.skyhookEntry import SkyhookEntry
from utillib import KeyVal

def row(item_id, name):
    return Bunch(selected=1, controller=KeyVal(GetItemID=lambda: item_id,
                 GetTypeID=lambda: 81080, GetCleanName=lambda: name))

first = row(9988400004071L, 'Orbital Skyhook - LZ-6SU X')
second = row(9988400004072L, 'Orbital Skyhook - MC6O-F I')
rows = [second, first]
scroll = KeyVal(GetNodes=lambda: rows)
scroll.GetSelectedNodes = lambda node: Scroll.GetSelectedNodes.im_func(scroll, node)
for node in rows:
    node.scroll = scroll

def dragged(node):
    payload = SkyhookEntry.GetDragData.im_func(KeyVal(sr=KeyVal(node=node)))
    return [[entry.itemID, entry.typeID, entry.label, entry.__guid__] for entry in payload]

both = dragged(first)
second.selected = 0
result = {'selected': both, 'single': dragged(first), 'origin': first.controller.GetItemID()}
