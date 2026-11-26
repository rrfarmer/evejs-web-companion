from eve.client.script.ui.shared.neocom.neocom import neocomContainer
from eve.client.script.ui.shared.neocom.wallet import walletConst, walletSvc, walletUtil
from localization import GetByLabel
from neocom2.transaction import PlexTransaction
from neocom2.walletPopupManager import WalletPopupManager
from plex.client import repository
from utillib import KeyVal


def observe():
    station_id = session.stationid
    preferences = {}
    hints = []
    converted = []
    active = [False]

    class Settings(object):
        def Get(self, name, fallback):
            return preferences.get(name, fallback)

    class Services(object):
        def GetService(self, name):
            return self

        def Blink(self, window, hint):
            hints.append([window, hint])

        def IsViewActive(self, view):
            return active[0]

    manager = WalletPopupManager(Settings(), None, None)
    target = KeyVal(walletPopupManager=manager, isProcessing=True)
    changes = [(walletSvc, 'sm', Services()), (neocomContainer, 'sm', Services()),
               (repository, 'on_balance_changed', lambda balance, amount: converted.append([balance, amount])),
               (walletUtil, 'settings', KeyVal(char=KeyVal(ui=Settings())))]
    missing = object()
    original = [(module, key, vars(module).get(key, missing)) for module, key, value in changes]
    rows = []
    try:
        for module, name, value in changes:
            setattr(module, name, value)
        for cents in (99, -99, 200, -200):
            repository.PlexRepository._on_balance_changed.__func__(
                KeyVal(), KeyVal(resulting_balance_in_cents=10025, amount_transferred_in_cents=cents))
        for name, amount, store, pref, live in [
            ('credit', 2, False, True, True), ('debit', -2, False, True, True),
            ('zero', 0, False, True, True), ('fractional', 0.99, False, True, True),
            ('store open', 2, True, True, True), ('blink off', 2, False, False, True),
            ('live updates off', 2, False, True, False),
        ]:
            preferences.update(notifyPlexBalanceChange=pref, walletShowBalanceUpdates=live, iskNotifyThreshold=9999)
            active[0] = store
            del hints[:]
            manager.ResetWaitingTransactions()
            walletSvc.WalletSvc._OnPLEXBalanceChange.__func__(None, 100, amount)
            neocomContainer.NeocomContainer._OnPLEXBalanceChanged.__func__(target, 100, amount)
            popups = [[t.get_balance_label(), t.get_formatted_value(), t.get_formatted_start_balance_value()]
                      for t in manager.waitingPlexTransactions]
            rows.append(dict(name=name, amount=amount, store=store, blink=pref, live=live, hints=list(hints), popups=popups))
        return dict(station=station_id, rows=rows, converted=converted, balance=PlexTransaction(0, 0).get_balance_label(),
                    label=GetByLabel(walletConst.SETTING_LABELS['notifyPlexBalanceChange']))
    finally:
        for module, name, value in original:
            if value is missing:
                delattr(module, name)
            else:
                setattr(module, name, value)


result = observe()
