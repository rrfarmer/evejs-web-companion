from eve.client.script.ui.shared.neocom.neocom.neocomWalletUpdater import WalletUpdater
from eve.client.script.ui.shared.neocom.wallet.panels import settings as wallet_settings
from localization import GetByLabel
from neocom2.transaction import IskTransaction
from neocom2.walletPopupManager import WalletPopupManager
from utillib import KeyVal


def observe():
    values = {}

    class CharacterSettings(object):
        def Get(self, name, fallback):
            return values.get(name, fallback)

        def Set(self, name, value):
            values[name] = value

    char_ui = CharacterSettings()
    manager = WalletPopupManager(char_ui, None, WalletUpdater)
    configured = []
    marker = object()
    original = vars(wallet_settings).get('settings', marker)
    try:
        wallet_settings.settings = KeyVal(char=KeyVal(ui=char_ui))
        for entered in ('10', '-10', 'bad', '', '10'):
            wallet_settings.SettingsWalletPanel.OnIskThresholdChanged.__func__(None, entered)
            configured.append([entered, values.get('iskNotifyThreshold')])
    finally:
        if original is marker:
            del wallet_settings.settings
        else:
            wallet_settings.settings = original
    cases = []
    for enabled, threshold in ((True, 0), (True, 10), (False, 0)):
        values.update(walletShowBalanceUpdates=enabled, iskNotifyThreshold=threshold)
        cases.append(dict(enabled=enabled, threshold=threshold, rows=[
            [delta, bool(manager._IsBalanceUpdateRelevant(delta))]
            for delta in (0, 0.99, -0.99, 1, -1, 9.99, -9.99, 10, -10, 13.5)
        ]))
    values.update(walletShowBalanceUpdates=True, iskNotifyThreshold=10)
    for balance, delta in ((110, 10), (125, 15), (112, -13)):
        manager.OnPersonalAccountChangedClient(balance, delta)
    batch = []
    def show(iskTransaction=None, **kwargs):
        batch.append([iskTransaction.get_start_balance_value(),
                      iskTransaction.new_balance, iskTransaction.transaction])
    manager.ShowWalletPopup = show
    manager.ProcessWaitingTransactions()
    timing = WalletUpdater([])
    return dict(station=session.stationid, configured=configured, cases=cases, batch=batch,
                delay=timing.initialDelay, duration=timing.showTime,
                labels=dict(
                    enabled=GetByLabel('UI/Wallet/WalletWindow/Configuration/WalletShowBalanceChange'),
                    threshold=GetByLabel('UI/Wallet/WalletWindow/Configuration/WalletBalanceChangeThreshold'),
                    balance=IskTransaction(110, 10).get_balance_label(),
                    credit=IskTransaction(110, 10).get_transaction_label(),
                    debit=IskTransaction(110, -10).get_transaction_label()))


result = observe()
