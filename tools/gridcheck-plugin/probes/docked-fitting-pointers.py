import blue
from carbonui.uicore import uicore
from eve.client.script.ui.shared.fittingScreen.fittingWnd import FittingWindow
from eve.client.script.ui.shared.pointerTool.pointerChains import FindChainForPointer
from eve.client.script.ui.shared.pointerTool.pointerToolFunctions import GetScreenElementsByUniqueName

names = ('fittingEquipment', 'fittingPersonalization', 'simulateShip', 'fittingStats',
         'fittingCap', 'fittingDefense', 'fittingDrones', 'fittingNavigation',
         'fittingOffense', 'fittingTargeting', 'fittingFighters', 'fittingFuel')
ids = ['unique_UI_' + name for name in names]
catalog = sm.GetService('helpPointer').GetHighlightByElementName()
rows = [dict(name=name, label=catalog[name].label, texture=catalog[name].texturePath,
             chain=FindChainForPointer(name)) for name in ids if name in catalog]
opened = FittingWindow.GetIfOpen()
if not opened:
    uicore.cmd.OpenFitting()
window = FittingWindow.GetIfOpen()
try:
    blue.pyos.synchro.SleepWallclock(500)
    anchors = GetScreenElementsByUniqueName(ids)
    visible = dict((name, list(element.GetAbsolute())) for name, element in anchors.iteritems()
                   if element and not element.destroyed and element.IsVisible())
    result = dict(station=session.stationid, rows=rows, visible=visible)
finally:
    if window and not opened:
        window.Close()
