import blue
from carbonui.uicore import uicore
from eve.client.script.ui.shared.neocom.corporation.corporationWindow import CorporationWindow
from eve.client.script.ui.shared.neocom.corporation.corpPanelConst import POINTER_UUID_BY_PANEL_ID
from eve.client.script.ui.shared.pointerTool import pointerToolConst, pointerToolUtil
from eve.client.script.ui.shared.pointerTool.pointerChains import FindChainForPointer
from eve.client.script.ui.shared.pointerTool.pointerToolFunctions import GetScreenElementsByUniqueName
from localization import GetByLabel


def observe():
    names = set(POINTER_UUID_BY_PANEL_ID.values())
    groups = pointerToolUtil.GetFilteredScrollList('', None, pointerToolConst.SOURCE_LOCATION_WINDOW)
    group = next(row for row in groups if row.label == GetByLabel('UI/Help/PointerWndUiElements'))
    rows = [dict(name=row.uiElementName, label=row.label, texture=row.texturePath,
                 chain=FindChainForPointer(row.uiElementName)) for row in group.GetSubContent(group) if row.uiElementName in names]
    previously_open = CorporationWindow.GetIfOpen()
    if not previously_open:
        uicore.cmd.OpenCorporationPanel()
    window = CorporationWindow.GetIfOpen()
    try:
        blue.pyos.synchro.SleepWallclock(700)
        live = GetScreenElementsByUniqueName(names)
        return dict(build=3698585, station=session.stationid, corporation=session.corpid, catalogue=rows,
                    visible=sorted(name for name, element in live.iteritems() if element and not element.destroyed and element.display))
    finally:
        if window and not previously_open:
            window.Close()


result = observe()
