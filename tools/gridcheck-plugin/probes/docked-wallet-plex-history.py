from eve.client.script.ui.shared.neocom.wallet.panels.personal.plex import transactions_panel
from eve.client.script.ui.shared.neocom.wallet.panels.personal.plex import transactions_exporting
from datetime import datetime
from localization import GetByLabel
from plex.client.api.repository import get_repository
from plex.client.repository import PlexRepository
from utillib import KeyVal


def observe():
    repo = get_repository()
    count = repo.get_transaction_logs_count()
    recent = repo.get_transaction_logs_page(3)
    details = []
    for ident in recent:
        row, invoice = repo.get_transaction_log_details(ident)
        details.append([str(ident.sequential), row.amount_transferred_in_cents,
                        row.resulting_balance_in_cents, row.timestamp.strftime('%Y.%m.%d %H:%M'),
                        invoice.category_message.get_localized_text() if invoice else None])
    hold = KeyVal(_transaction_identifiers=list(reversed(range(52))), _cache_transaction_logs=lambda: None)
    paging = PlexRepository.get_transaction_logs_page.__func__
    row = KeyVal(timestamp=datetime(2026, 11, 25, 18, 1, 7), amount_transferred_in_cents=-101,
                 resulting_balance_in_cents=250)
    invoice = KeyVal(category_message=KeyVal(get_localized_text=lambda: 'CCP'),
                     summary_message=KeyVal(get_localized_text=lambda: 'Credit, with comma'))
    return dict(station=session.stationid, count=count, details=details,
                pageSize=transactions_panel.TRANSACTIONS_PER_PAGE,
                nextPage=paging(hold, 50, 50), ascendingTail=paging(hold, 50, 50, True),
                csv=transactions_exporting._convert_to_csv([(row, invoice)]),
                labels=[GetByLabel(path) for path in ('UI/PlexVault/Logs/SortAscending',
                        'UI/PlexVault/Logs/SortDescending', 'UI/PlexVault/Logs/ExportAll')])


result = observe()
