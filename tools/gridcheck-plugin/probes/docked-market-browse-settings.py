from carbonui.uicore import uicore
from eve.client.script.ui.shared.market.marketbase import RegionalMarket
from localization import GetByLabel


class MenuRows(object):
    def __init__(self):
        self.rows = []

    def AddCheckBox(self, text, checked, callback):
        self.rows.append(['checkbox', text, bool(checked)])

    def AddRadioButton(self, text, checked, callback):
        self.rows.append(['radio', text, bool(checked)])

    def AddText(self, text):
        self.rows.append(['label', text])

    def AddButton(self, text, callback):
        self.rows.append(['button', text])

    def AddSpace(self):
        pass


def observe():
    opened = RegionalMarket.GetIfOpen()
    if not opened:
        uicore.cmd.OpenMarket()
    window = RegionalMarket.GetIfOpen()
    market = window.sr.market
    keys = ('showonlyavailable', 'showonlyskillsfor', 'showhavecpuandpower', 'shownewskills', 'autorefresh')
    saved = [(key, settings.user.ui.Get(key, None)) for key in keys]
    reload_list = market.LoadMarketListOrSearch
    original_skills = getattr(market, 'mine', None)
    original_asks = getattr(market, 'asksForMyRange', None)
    try:
        market.LoadMarketListOrSearch = lambda: None
        for key in keys:
            settings.user.ui.Set(key, key in ('showonlyskillsfor', 'showhavecpuandpower', 'shownewskills'))
        range_before = market.GetRange()
        before = MenuRows()
        market.SettingMenu(before)
        market.ResetFilterSettings()
        after = MenuRows()
        market.SettingMenu(after)
        fitting = sm.GetService('godma').GetItem(session.shipid)
        market.mine = market.GetMySkills()
        market.asksForMyRange = {34: True}
        branches = [node.label for node in market.GetGroupListForBrowse()]
        return dict(station=session.stationid, before=before.rows, after=after.rows,
                    rangeBefore=range_before, rangeAfter=market.GetRange(),
                    autorefresh=settings.user.ui.Get('autorefresh'),
                    searchHint=GetByLabel('UI/Market/FiltersDontApply'),
                    projectedAskRoot=branches,
                    requirements=[[type_id, list(market.MeetsRequirements(type_id, ship=fitting,
                                   reqTypeSkills=True, reqTypeCpuPower=True, hasSkill=True))]
                                  for type_id in (34, 3300, 2454)])
    finally:
        market.LoadMarketListOrSearch = reload_list
        market.mine = original_skills
        market.asksForMyRange = original_asks
        for key, value in saved:
            if value is None:
                settings.user.ui.Delete(key)
            else:
                settings.user.ui.Set(key, value)
        if not opened:
            window.Close()


result = observe()
