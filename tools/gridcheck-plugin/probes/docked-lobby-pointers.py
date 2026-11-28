from eve.client.script.ui.shared.pointerTool.pointerChains import FindChainForPointer
from eve.client.script.ui.shared.pointerTool.pointerToolFunctions import GetScreenElementsByUniqueName

POINTERS = ('unique_UI_undockBtn', 'unique_UI_corvetteBtn', 'serviceButtons',
            'unique_UI_stationSvcAgents', 'unique_UI_stationSvcGuests',
            'unique_UI_stationSvcOffices', 'unique_UI_stationSvcHangars')


def observe():
    catalog = sm.GetService('helpPointer').GetHighlightByElementName()
    anchors = GetScreenElementsByUniqueName(POINTERS)
    rows = []
    for name in POINTERS:
        entry = catalog.get(name)
        anchor = anchors.get(name)
        if entry:
            rows.append(dict(name=name, label=entry.label, texture=entry.texturePath, chain=FindChainForPointer(name),
                             bounds=list(anchor.GetAbsolute()) if anchor and not anchor.destroyed and anchor.IsVisible() else None))
    return dict(build=3698585, station=session.stationid, rows=rows)


result = observe()
