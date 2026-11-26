from eve.client.script.ui.shared.neocom.neocom import neocomSvc
from eve.client.script.ui.shared.neocom.wallet import walletUtil
from eve.common.lib.appConst import corpHeraldry
from localization import GetByLabel
from neocom2.transaction import LpTransaction
from neocom2.walletPopupManager import WalletPopupManager
from utillib import KeyVal


def observe():
    values = {'walletShowBalanceUpdates': True, 'iskNotifyThreshold': 10}
    hints = []
    events = []
    station_id = session.stationid

    class Settings(object):
        def Get(self, key, default):
            return values.get(key, default)

    class Services(object):
        def GetService(self, name):
            return self

        def Blink(self, key, hint):
            hints.append(hint)

        def ScatterEvent(self, name, issuer, before, after):
            events.append([issuer, before, after])
            manager.OnLpUpdated(issuer, before, after)

    manager = WalletPopupManager(Settings(), None, None)
    changes = [(neocomSvc, 'sm', Services()),
               (walletUtil, 'settings', KeyVal(char=KeyVal(ui=Settings())))]
    missing = object()
    original = [(module, key, vars(module).get(key, missing)) for module, key, value in changes]
    issuers = [1000035, 1000125, corpHeraldry]
    cases = [
        ('at threshold', issuers[0], 100, 110, True, True),
        ('below threshold', issuers[0], 100, 109, True, True),
        ('null balance', issuers[0], None, 110, True, True),
        ('null issuer', None, 100, 110, True, True),
        ('lp off', issuers[0], 100, 110, False, True),
        ('live updates off', issuers[0], 100, 110, True, False),
        ('EverMarks debit', issuers[2], 100, 90, True, True),
    ]
    rows = []
    grouped = []
    def capture(iskTransaction=None, lpTransactionByCorp=None, plexTransaction=None):
        for issuer, tx in sorted(lpTransactionByCorp.items()):
            grouped.append([issuer, tx.get_start_balance_value(), tx.new_balance, tx.transaction])
    manager.ShowWalletPopup = capture
    try:
        for module, name, value in changes:
            setattr(module, name, value)
        for name, issuer, before, after, lp, live in cases:
            values.update(walletShowLpUpdates=lp, walletShowBalanceUpdates=live)
            del hints[:]
            del events[:]
            manager.ResetWaitingTransactions()
            neocomSvc.NeocomSvc.OnCharacterLPBalanceChange_Local.__func__(None, issuer, before, after)
            popups = []
            for tx in manager.waitingLpTransactionsByCorp.get(issuer, []):
                popups.append([tx.get_balance_label(), tx.get_formatted_value(), tx.get_formatted_start_balance_value()])
            rows.append(dict(name=name, issuer=issuer, before=before, after=after, lp=lp, live=live,
                             hints=list(hints), events=list(events), popups=popups))
        values.update(walletShowLpUpdates=True, walletShowBalanceUpdates=True)
        manager.ResetWaitingTransactions()
        for issuer, before, after in [(issuers[0], 100, 115), (issuers[1], 20, 40), (issuers[0], 115, 103)]:
            manager.OnLpUpdated(issuer, before, after)
        manager.ProcessWaitingTransactions()
        labels = [[issuer, LpTransaction(issuer, 100, 10).get_balance_label()] for issuer in issuers]
        return dict(station=station_id, label=GetByLabel('UI/Wallet/WalletWindow/Configuration/WalletShowLpUpdate'),
                    rows=rows, grouped=grouped, issuerLabels=labels)
    finally:
        for module, name, value in original:
            if value is missing:
                delattr(module, name)
            else:
                setattr(module, name, value)


result = observe()
