# Read the installed market group and observe its tab when Regional Market is available.
import blue
import evetypes
from eve.client.script.ui.shared.market.marketbase import RegionalMarket
from localization import GetByLabel

group_id = evetypes.GetMarketGroupID(1230)
group = sm.GetService('marketutils').GetMarketGroupByID(group_id)
path = [group.marketGroupName]
parent = group.parentGroupID
while parent:
    ancestor = sm.GetService('marketutils').GetMarketGroupByID(parent)
    if ancestor is None:
        break
    path.insert(0, ancestor.marketGroupName)
    parent = ancestor.parentGroupID
existing = RegionalMarket.GetIfOpen()
market = existing or RegionalMarket.Open()
out = {'label': GetByLabel('UI/Common/Groups'), 'groupID': group_id, 'group': group.marketGroupName, 'path': path}
try:
    for attempt in range(20):
        if market.sr.tabs is not None:
            break
        blue.synchro.SleepWallclock(100)
    out['tabsReady'] = market.sr.tabs is not None
    if out['tabsReady']:
        market.LoadMarketGroup(group_id)
        blue.synchro.SleepWallclock(300)
        out['selected'] = market.sr.tabs.GetSelectedID()
        out['children'] = [child.name for child in market._group_panel.children]
    result = out
finally:
    if existing is None:
        market.Close()
