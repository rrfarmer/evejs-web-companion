import blue
from carbonui.uicore import uicore
from eve.client.script.ui.shared.mapView.mapViewPanel import MapViewPanel
from eve.client.script.ui.shared.pointerTool.pointerToolFunctions import GetScreenElementsByUniqueName


def observe():
    name = 'unique_UI_mapJumpRangeToggle'
    existing = MapViewPanel.GetIfOpen()
    if not existing:
        uicore.cmd._CmdToggleMapBeta()
    window = MapViewPanel.GetIfOpen()
    try:
        blue.pyos.synchro.SleepWallclock(700)
        view = window.mapView
        anchor = GetScreenElementsByUniqueName([name]).get(name)
        sample_range = 5.0
        exact = view._GetSystemsInJumpRangeFromSystem(sample_range, session.solarsystemid2, True)
        inside = sorted(system for system, mode in exact.iteritems() if mode == 1)
        excluded = sorted(system for system, mode in exact.iteritems() if mode == 4)
        return dict(build=3698585, station=session.stationid, system=session.solarsystemid2,
                    ship=session.shipid, range=view.GetJumpDriveRange(), visible=bool(anchor and anchor.IsVisible()),
                    sample=dict(range=sample_range, inside=len(inside), excluded=len(excluded),
                                targets=inside[:4], ineligible=excluded[:4]))
    finally:
        if window and not existing:
            window.Close()


result = observe()
