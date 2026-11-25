# Observe the installed client export label, timestamp, and available book columns.
import blue
from carbon.common.script.util.format import FmtDateEng
from localization import GetByLabel

out = {
    'label': GetByLabel('UI/Market/Marketbase/ExportToFile'),
    'hint': GetByLabel('Tooltips/Market/MarketDetailsExportFile'),
    'empty': GetByLabel('UI/Market/MarketWindow/ExportNoData'),
    'timestamp': FmtDateEng(blue.os.GetWallclockTime()).replace(':', ''),
    'columns': [],
}
try:
    sells, buys = sm.GetService('marketQuote').GetOrders(1230)[0:2]
    out['counts'] = [len(sells[0]), len(buys[0])]
    rows = sells[0] or buys[0]
    if len(rows):
        out['columns'] = list(rows[0].__columns__)
except Exception as error:
    out['bookError'] = unicode(error)
result = out
