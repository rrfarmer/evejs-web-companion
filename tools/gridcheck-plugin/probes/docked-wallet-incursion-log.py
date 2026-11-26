from eve.client.script.ui.shared.neocom.wallet.panels.personal import lpIncursionsPanel as inc
from eve.common.lib import appConst
from utillib import KeyVal


def observe():
    live = sm.RemoteSvc('rewardMgr').GetRewardLPLogs()
    date = inc.ParseSmallDate('2026.11.25')
    base = dict(solarSystemID=30000142, taleID=4201, rewardID=1,
                rewardMessageKey='UI/Incursion/Journal/Types', numberOfPlayers=7,
                lpAmountAddedToPool=0, lpAmountPayedOut=0, disqualifierType=None, disqualifierData=None)
    cases = [(312, 'Held', 1000, 0, None), (313, 'Paid', 0, 600, None),
             (314, 'Lost', 0, 50, None), (471, 'Direct', 0, 250, None),
             (315, 'Disqualified', 0, 0, appConst.rewardIneligibleReasonShipCloaked)]
    sample = []
    for i, (event, name, stored, paid, reason) in enumerate(cases):
        fields = dict(base, eventTypeID=event, dungeonName=name, lpAmountAddedToPool=stored,
                      lpAmountPayedOut=paid, disqualifierType=reason, date=date + i * appConst.SEC)
        sample.append(KeyVal(**fields))
    sample.append(KeyVal(**dict(base, eventTypeID=312, dungeonName='Next day', date=date + appConst.DAY + 1)))
    probes = []

    class Combo(object):
        def __init__(self, value=None):
            self.selectedValue = value
            self.options = []

        def LoadOptions(self, options):
            self.options = options

        def SelectItemByValue(self, value):
            self.selectedValue = value

    class Scroll(object):
        hint = ''

        def GetSortBy(self):
            return None

        def GetSortDirection(self):
            return 1

        def LoadContent(self, contentList, headers, **kwargs):
            self.content = contentList
            self.headers = headers

        def Sort(self, **kwargs):
            pass

        def Clear(self):
            self.content = []

        def ShowHint(self, hint):
            self.hint = hint

    old = inc.GetFromClass
    try:
        inc.GetFromClass = lambda _, row: row
        for kind in [None, -1, -2]:
            scroll = Scroll()
            target = KeyVal(scroll=scroll, incursionTaleIDFilter=Combo(), incursionTypeFilter=Combo(kind),
                            incursionLPDate=KeyVal(GetValue=lambda: '2026.11.25'))
            inc.LPIncursionsPanel.UpdateIncursionLPLog.__func__(target, sample)
            probes.append(dict(headers=scroll.headers, rows=[row['label'].split('<t>') for row in scroll.content],
                               types=[option[0] for option in target.incursionTypeFilter.options[:3]]))
    finally:
        inc.GetFromClass = old
    return dict(station=session.stationid, liveCount=len(live), probes=probes)


result = observe()
