import blue
from carbonui.uicore import uicore
from eve.client.script.ui.shared.industry.industryWnd import Industry
from eve.client.script.ui.shared.pointerTool import pointerToolConst, pointerToolUtil
from eve.client.script.ui.shared.pointerTool.pointerChains import FindChainForPointer
from eve.client.script.ui.shared.pointerTool.pointerToolFunctions import GetScreenElementsByUniqueName
from localization import GetByLabel


def observe():
    service = sm.GetService('helpPointer')
    elements = GetScreenElementsByUniqueName(service.GetAllPointersByElementName().keys())
    groups = pointerToolUtil.GetFilteredScrollList('', None, pointerToolConst.SOURCE_LOCATION_WINDOW)
    authored_header = GetByLabel('UI/Help/PointerWndUiElements')
    authored = []
    industry = []
    for group in groups:
        if group.label != authored_header:
            continue
        for row in group.GetSubContent(group):
            name = row.uiElementName
            authored.append(name)
            if row.label.lower().startswith('industry'):
                industry.append(dict(name=name, label=row.label, longName=row.longName,
                                     texture=row.texturePath, chain=FindChainForPointer(name)))
    opened = Industry.GetIfOpen()
    if not opened:
        uicore.cmd.OpenIndustry()
    window = Industry.GetIfOpen()
    try:
        blue.pyos.synchro.SleepWallclock(450)
        anchors = GetScreenElementsByUniqueName([row['name'] for row in industry])
        industry_live = dict((name, list(element.GetAbsolute())) for name, element in anchors.iteritems()
                             if element and not element.destroyed and element.display)
    finally:
        if window and not opened:
            window.Close()
    return dict(station=session.stationid,
                groups=[[group.label, len(group.get('groupItems', []))] for group in groups],
                visible=sorted(name for name, element in elements.iteritems()
                               if element and not element.destroyed and element.display),
                authored=authored, industry=industry, industryLive=industry_live)


result = observe()
