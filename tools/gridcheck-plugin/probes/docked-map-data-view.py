import blue
from carbonui.uicore import uicore
from eve.client.script.ui.shared.mapView.mapViewPanel import MapViewPanel
from eve.client.script.ui.shared.mapView.mapViewSettings import mapPreviewModeActive
from eve.client.script.ui.shared.pointerTool.pointerToolFunctions import GetScreenElementsByUniqueName


def observe():
    name = 'unique_UI_mapDataViewToggle'
    existing = MapViewPanel.GetIfOpen()
    if not existing:
        uicore.cmd._CmdToggleMapBeta()
    window = MapViewPanel.GetIfOpen()
    old = mapPreviewModeActive.get()
    try:
        blue.pyos.synchro.SleepWallclock(700)
        eye = GetScreenElementsByUniqueName([name]).get(name)
        if not eye:
            return dict(build=3698585, station=session.stationid, available=False)
        states = []
        for unused in range(2):
            eye.OnClick()
            states.append(dict(active=bool(mapPreviewModeActive.get()), texture=eye.texturePath,
                               showAll=bool(window.mapView.ShouldShowPreviewForAll())))
        return dict(build=3698585, station=session.stationid, available=True,
                    original=bool(old), states=states, restored=bool(mapPreviewModeActive.get()))
    finally:
        if mapPreviewModeActive.get() != old:
            mapPreviewModeActive.set(old)
        if window and not existing:
            window.Close()


result = observe()
