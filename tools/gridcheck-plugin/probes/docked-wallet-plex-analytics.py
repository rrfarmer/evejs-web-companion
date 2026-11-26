from carbon.common.script.util.format import FmtAmt
from eve.client.script.ui.shared.neocom.wallet.panels.personal.plex.overview_controls import ChartControls
from eve.client.script.ui.shared.neocom.wallet.panels.personal.plex.util import ChartMode, COLOR_BY_MESSAGE_ID
from localization import GetByLabel
from plex.client.api.repository import get_repository
from plex.client.model.transaction_statistics import TransactionStatistics, TransactionStatisticsEntry
from utillib import KeyVal


def observe():
    stats = get_repository().get_transaction_statistics()
    live = [[row.category_message.identifier, row.category_message.get_localized_text(), row.incomes_in_cents,
             row.expenses_in_cents, row.count] for row in stats.entries]
    fixture = TransactionStatistics(stats.earliest_transaction_time, [
        TransactionStatisticsEntry(KeyVal(identifier=1021282), 1500, -500, 2),
        TransactionStatisticsEntry(KeyVal(identifier=1021278), 4500, -1000, 2),
        TransactionStatisticsEntry(None, 0, -500, 1)])
    mode_rows = []
    for mode in [ChartMode.INCOME, ChartMode.EXPENSES]:
        legend = []
        amounts = []
        def set_amount(amount, sign):
            amounts.append([amount, sign])
        target = KeyVal(chart_mode=mode, income_button=KeyVal(set_amount=set_amount),
                        expenses_button=KeyVal(set_amount=set_amount),
                        category_list_container=KeyVal(Flush=lambda: None),
                        add_list_entry=lambda entry: legend.append(entry))
        target.get_chart_entries = lambda data: ChartControls.get_chart_entries.__func__(target, data)
        ChartControls.update.__func__(target, fixture, dict((row.category_message.identifier, row.category_message.identifier) for row in fixture.entries))
        mode_rows.append(dict(totals=amounts, legend=legend))
    return dict(station=session.stationid, live=live, totals=[stats.total_income_in_cents, stats.total_expenses_in_cents],
                modes=mode_rows, ccpColor=list(COLOR_BY_MESSAGE_ID[1021282]),
                labels=[GetByLabel(path) for path in ['UI/Wallet/WalletWindow/Income',
                        'UI/Wallet/WalletWindow/Expenses', 'UI/Wallet/WalletWindow/HintNoTransactionsFound']],
                formatted=[FmtAmt(amount, fmt='sn') for amount in [0, 60, 1000, 2222, 1000000]])


result = observe()
