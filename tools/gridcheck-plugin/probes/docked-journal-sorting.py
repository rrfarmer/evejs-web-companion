from carbonui.control import scroll
from eve.client.script.ui.control.entries.util import GetFromClass
from eve.client.script.ui.shared.neocom.journal import JournalWindow
from eve.client.script.ui.station.missions.missionentry import VirtualAgentMissionEntry
from localization import GetByLabel


def observe():
    wnd = JournalWindow.Open()
    wnd.ShowAgentTab(0)
    table = wnd.sr.scroll
    key = 'scrollsortby_%s' % scroll.VERSION
    saved = settings.user.ui.Get(key, {}).copy()
    try:
        kept = saved.copy()
        kept.pop('agentjournalscroll0', None)
        settings.user.ui.Set(key, kept)
        path = 'UI/Journal/JournalWindow/Agents/'
        headers = [GetByLabel(label) for label in (path + 'HeaderStatus', 'UI/Agents/Agent',
                   path + 'HeaderMission', path + 'HeaderType', path + 'HeaderExpiration')]
        cells = [
            ('<color=0xFFFFFF00>Offered<color=0xffffffff>', 'Zulu Level 1', 'Alpha', 'Trade', 'Expires in 2h'),
            ('<color=0xff00FF00>Accepted<color=0xffffffff>', 'alpha Level 1', 'Zulu', 'Encounter', 'Expires in 12h'),
            ('<color=0xff00FF00>Accepted<color=0xffffffff>', 'Alpha Level 1', 'Beta', 'Encounter', 'Expires in 3h'),
        ]
        def load(target):
            target.Load(contentList=[GetFromClass(VirtualAgentMissionEntry, dict(
                agentID=3012018 + index, missionState=1, label='<t>'.join(row),
                missionIconData=[])) for index, row in enumerate(cells)], headers=headers)
        def snapshot(target):
            return [[node.agentID, node.label] for node in target.GetNodes()]
        load(table)
        initial = snapshot(table)
        keys = [table.GetSortValue(header, table.GetNodes()[0], index) for index, header in enumerate(headers)]
        series = []
        for header in headers:
            table.ChangeSortBy(header)
            first = snapshot(table)
            first_direction = table.GetSortDirection()
            table.ChangeSortBy(header)
            series.append(dict(header=header, first=first, second=snapshot(table), firstReverse=first_direction,
                               secondReverse=table.GetSortDirection()))
        setting = settings.user.ui.Get(key, {}).get('agentjournalscroll0')
        wnd.Close()
        wnd = JournalWindow.Open()
        wnd.ShowAgentTab(0)
        load(wnd.sr.scroll)
        return dict(build=3698585, station=session.stationid, scrollID=wnd.sr.scroll.sr.id, headers=headers,
                    initial=initial, keys=keys, series=series, setting=setting, restored=snapshot(wnd.sr.scroll))
    finally:
        settings.user.ui.Set(key, saved)
        wnd.Close()


result = observe()
