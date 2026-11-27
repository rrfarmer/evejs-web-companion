import blue
from carbonui.uicore import uicore
from eve.client.script.ui.shared.info.shipInfoConst import TAB_OVERVIEW, TAB_SKINS
from eve.client.script.ui.shared.info.shipInfoWindow import ShipInfoWindow
from eve.client.script.ui.shared.killReport import KillReportWnd
from eve.client.script.ui.shared.portraitWindow.portraitWindow import PortraitWindow
from eve.client.script.ui.shared.preview import PreviewWnd


def observe():
    if KillReportWnd.GetIfOpen() or PortraitWindow.GetIfOpen() or PreviewWnd.GetIfOpen():
        raise RuntimeError('A preview or report window is already open')
    recent = sm.RemoteSvc('charMgr').GetRecentShipKillsAndLosses(25, None)
    if not recent:
        raise RuntimeError('The reference pilot has no kill report')
    report = recent[0]
    before = set(uicore.registry.GetWindows())
    try:
        window = KillReportWnd.Open(windowID='KillReportWnd', killmail=report)
        window.OpenPortrait(report.victimCharacterID)
        photo = PortraitWindow.GetIfOpen()
        window.OpenPreview(report.victimShipTypeID)
        for _ in range(60):
            ships = [wnd for wnd in uicore.registry.GetWindows() if wnd not in before and isinstance(wnd, ShipInfoWindow)]
            if ships and ships[0]._selectedTab == TAB_SKINS:
                break
            blue.synchro.SleepWallclock(100)
        if not photo or not ships:
            raise RuntimeError('The portrait or ship information window did not open')
        ship = ships[0]
        selected = ship._selectedTab
        ship.open_tab_by_id(TAB_OVERVIEW)
        ship.Minimize()
        window.OpenPreview(report.victimShipTypeID)
        blue.synchro.SleepWallclock(500)
        duplicate_tab = ship._selectedTab
        dna = sm.RemoteSvc('paperDollServer').GetPaperDollData(report.victimCharacterID)
        return dict(station=session.stationid, portraitID=photo.charID, size=photo.photoSize,
                    portraitCaption=photo.GetCaption(), portraitMenu=[row[0].GetText() for row in photo.PicMenu()],
                    fullBodyData=dna is not None, hull=report.victimShipTypeID,
                    selectedTab=selected, duplicateTab=duplicate_tab,
                    standalone=PreviewWnd.GetIfOpen() is not None)
    finally:
        for wnd in uicore.registry.GetWindows():
            if wnd not in before and isinstance(wnd, (ShipInfoWindow, PortraitWindow, KillReportWnd, PreviewWnd)):
                wnd.Close()


result = observe()
