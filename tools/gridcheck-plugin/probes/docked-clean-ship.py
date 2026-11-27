import blue
from carbonui.uicore import uicore
from eve.common.script.net import eveMoniker
from localization import GetByLabel
from eve.client.script.ui.shared.fittingScreen.fittingWnd import FittingWindow, TAB_ID_COSMETIC

opened = FittingWindow.GetIfOpen()
if not opened:
    uicore.cmd.OpenFitting()
window = FittingWindow.GetIfOpen()
try:
    window.fittingModeTabGroup.SelectByID(TAB_ID_COSMETIC)
    blue.pyos.synchro.SleepWallclock(400)
    button = window.cosmeticsPanel.cleanShipButton
    ship = session.shipid
    access = eveMoniker.GetShipAccess()
    before = access.GetDirtTimestamp(ship)
    blue.pyos.synchro.SleepWallclock(120)
    button.CleanShip()
    after = access.GetDirtTimestamp(ship)
    result = dict(station=session.stationid, ship=ship, label=GetByLabel('UI/Fitting/FittingWindow/CleanShip'),
                  displayed=button.display, before=str(before), after=str(after), increased=after > before)
finally:
    if window and not opened:
        window.Close()
