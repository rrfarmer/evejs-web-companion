import blue
from carbonui.uicore import uicore
from eve.client.script.ui.shared.fittingScreen.fittingWnd import FittingWindow, TAB_ID_FITTING, TAB_ID_COSMETIC
from eve.client.script.ui.shared.fittingScreen.cosmetics.cosmeticFitting import TAB_ID_SKINS, TAB_ID_EMBLEMS
from eve.client.script.ui.shared.pointerTool.pointerChains import FindChainForPointer
from eve.client.script.ui.shared.pointerTool.pointerToolFunctions import GetScreenElementsByUniqueName
from localization import GetByLabel

names = ['unique_UI_fittingEquipment', 'unique_UI_fittingPersonalization', 'unique_UI_fittingSkins']
catalog = sm.GetService('helpPointer').GetHighlightByElementName()
rows = [dict(name=name, label=catalog[name].label, texture=catalog[name].texturePath,
             chain=FindChainForPointer(name)) for name in names if name in catalog]
opened = FittingWindow.GetIfOpen()
if not opened:
    uicore.cmd.OpenFitting()
window = FittingWindow.GetIfOpen()
try:
    blue.pyos.synchro.SleepWallclock(500)
    window.fittingModeTabGroup.SelectByID(TAB_ID_COSMETIC)
    blue.pyos.synchro.SleepWallclock(500)
    panel = window.cosmeticsPanel
    skins = panel.cosmeticTypeTabGroup.GetSelectedID()
    anchors = GetScreenElementsByUniqueName(names)
    visible = [name for name in names if name in anchors and anchors[name].IsVisible()]
    panel.GoToTab(TAB_ID_EMBLEMS)
    blue.pyos.synchro.SleepWallclock(200)
    emblems = panel.cosmeticTypeTabGroup.GetSelectedID()
    window.fittingModeTabGroup.SelectByID(TAB_ID_FITTING)
    result = dict(station=session.stationid, shipType=window.controller.typeID, rows=rows, visible=visible,
                  panes=[skins, emblems], fittingBack=window.fittingModeTabGroup.GetSelectedID(),
                  labels=[GetByLabel('UI/ShipCosmetics/'+name) for name in ('Personalization','Skins','Emblems')])
finally:
    if window and not opened:
        window.Close()
