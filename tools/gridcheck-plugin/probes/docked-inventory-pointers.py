import blue
from carbonui.uicore import uicore
from eve.client.script.ui.shared.inventory.invWindow import InventoryPrimary
from eve.client.script.ui.shared.pointerTool.pointerChains import FindChainForPointer
from eve.client.script.ui.shared.pointerTool.pointerToolFunctions import GetScreenElementsByUniqueName
from uihighlighting import uniqueNameConst

ids = [uniqueNameConst.UNIQUE_NAME_INVENTORY_STACK_ALL, uniqueNameConst.UNIQUE_NAME_INVENTORY_VIEW]
catalog = sm.GetService('helpPointer').GetHighlightByElementName()
rows = [dict(name=name, label=catalog[name].label, texture=catalog[name].texturePath,
             chain=FindChainForPointer(name)) for name in ids]
opened = InventoryPrimary.GetIfOpen()
if not opened:
    uicore.cmd.OpenInventory()
window = InventoryPrimary.GetIfOpen()
try:
    blue.pyos.synchro.SleepWallclock(300)
    anchors = GetScreenElementsByUniqueName(ids)
    visible = dict((name, list(element.GetAbsolute())) for name, element in anchors.iteritems()
                   if element and not element.destroyed and element.IsVisible())
    result = dict(station=session.stationid, rows=rows, visible=visible)
finally:
    if window and not opened:
        window.Close()
