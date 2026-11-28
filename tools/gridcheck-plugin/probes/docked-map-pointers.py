import blue
from carbonui.uicore import uicore
from eve.client.script.ui.shared.mapView.mapViewPanel import MapViewPanel
from eve.client.script.ui.shared.pointerTool.pointerChains import FindChainForPointer
from eve.client.script.ui.shared.pointerTool.pointerToolFunctions import GetScreenElementsByUniqueName


names = ('mapLayout', 'mapFocusCurrentLocation', 'mapFocusHomeStation', 'mapColorSettings',
         'map2DLayoutToggle', 'mapJumpRangeToggle', 'mapDataViewToggle')
ids = ['unique_UI_' + name for name in names]
catalog = sm.GetService('helpPointer').GetHighlightByElementName()
rows = [dict(name=name, label=catalog[name].label, texture=catalog[name].texturePath,
             chain=FindChainForPointer(name)) for name in ids if name in catalog]
opened = MapViewPanel.GetIfOpen()
if not opened:
    uicore.cmd._CmdToggleMapBeta()
window = MapViewPanel.GetIfOpen()
try:
    blue.pyos.synchro.SleepWallclock(500)
    anchors = GetScreenElementsByUniqueName(ids)
    visible = dict((name, list(element.GetAbsolute())) for name, element in anchors.iteritems()
                   if element and not element.destroyed and element.IsVisible())
    home = sm.GetService('charactersheet').GetHomeStationRow()
    result = dict(build=3698585, station=session.stationid, system=session.solarsystemid2,
                  homeStation=home.stationID if home else None,
                  homeSystem=home.solarSystemID if home else None, rows=rows, visible=visible)
finally:
    if window and not opened:
        window.Close()
