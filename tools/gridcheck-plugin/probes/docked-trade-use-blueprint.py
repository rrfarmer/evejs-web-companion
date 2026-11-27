"""Invoke Use Blueprint from the installed client's active trade offer."""
import blue
from carbonui.control.contextMenu.menuDataFactory import CreateMenuDataFromRawTuples
from carbonui.control.window import Window
from eve.client.script.ui.shared.industry.industryWnd import Industry
from eveexceptions import UserError
from eveservices.menu import GetMenuService
from inventorycommon import const

trade_window = Window.GetIfOpen(windowID='tradeWnd')
if not trade_window or not trade_window.tradeSession:
    raise RuntimeError('Open a trade with a blueprint first')
trade = trade_window.tradeSession.List()
item = next((row for row in trade.items if row.categoryID == const.categoryBlueprint), None)
if not item:
    raise RuntimeError('No offered blueprint')
menu = CreateMenuDataFromRawTuples(GetMenuService().InvItemMenu([(item, True, None)]))
action = next((entry for entry in menu if entry and entry.GetLabelPath() == 'UI/Industry/UseBlueprint'), None)
if action is None:
    raise RuntimeError('Use Blueprint is absent')

industry = Industry.GetIfOpen()
if industry:
    industry.Close()
error = None
try:
    action.func()
except UserError as refusal:
    error = refusal.msg
job = None
for _ in xrange(30):
    industry = Industry.GetIfOpen()
    job = getattr(industry, 'jobData', None) if industry and not industry.destroyed else None
    if job or error:
        break
    blue.synchro.SleepWallclock(100)

result = {'pilot': session.charid, 'container': trade.tradeContainerID, 'item': item.itemID,
          'owner': item.ownerID, 'type': item.typeID, 'label': action.GetText(), 'error': error,
          'window': bool(industry and not industry.destroyed),
          'selected': job.blueprintID if job is not None else None,
          'blueprintType': job.blueprint.blueprintTypeID if job is not None else None}
