import blue
from carbonui.uicore import uicore
from eve.client.script.ui.shared.fittingScreen.fittingWnd import FittingWindow, TAB_ID_COSMETIC
from eve.client.script.ui.shared.fittingScreen.cosmetics.cosmeticFitting import TAB_ID_EMBLEMS

opened = FittingWindow.GetIfOpen()
if not opened:
    uicore.cmd.OpenFitting()
window = FittingWindow.GetIfOpen()
try:
    window.fittingModeTabGroup.SelectByID(TAB_ID_COSMETIC)
    blue.pyos.synchro.SleepWallclock(500)
    window.cosmeticsPanel.GoToTab(TAB_ID_EMBLEMS)
    blue.pyos.synchro.SleepWallclock(350)
    panel = window.cosmeticsPanel
    center = panel.cosmeticFittingCenter
    result = dict(station=session.stationid, ship=session.shipid, tab=panel.cosmeticTypeTabGroup.GetSelectedID(),
                  scene=type(center.shipSceneContainer).__name__, centerDisplayed=bool(center.display),
                  slots=sorted([len(slots) for slots in center.slots.values()]))
finally:
    if window and not opened:
        window.Close()
