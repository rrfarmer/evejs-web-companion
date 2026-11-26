from eve.client.script.ui.shared.neocom.wallet import walletConst, walletSvc, walletUtil
from eve.client.script.ui.shared.neocom.wallet.walletWnd import WalletWindow
from localization import GetByLabel
from utillib import KeyVal


def observe():
    values = {}
    events = []
    station_id = session.stationid
    pilot = KeyVal(charid=session.charid, corpid=session.corpid, corprole=0)

    class Services(object):
        def GetService(self, name):
            return self

        def Blink(self, window, hint):
            events.append([window, hint])

        def ScatterEvent(self, name, *args):
            pass

    class OpenWindow(object):
        @staticmethod
        def GetIfOpen():
            return OpenWindow()

        def BlinkPanelByIDs(self, ids):
            events.append(ids)

    class Wallet(object):
        wealth = 50
        _OnCharAccountChange = walletSvc.WalletSvc._OnCharAccountChange.__func__
        _OnCorpAccountChange = walletSvc.WalletSvc._OnCorpAccountChange.__func__
        _GetCorpAccountKey = walletSvc.WalletSvc._GetCorpAccountKey.__func__

        def GetCorpWealthCached1Min(self, key):
            return 50

        def UpdateCachedBalance(self, key, balance):
            pass

        def BlinkPersonalWallet(self, panel):
            WalletWindow.BlinkPersonalWallet.__func__(OpenWindow, panel)

        def BlinkCorpWallet(self):
            WalletWindow.BlinkCorpWallet.__func__(OpenWindow)

    def get_setting(name, fallback):
        return values.get(name, fallback)

    changes = [(walletSvc, 'sm', Services()), (walletSvc, 'session', pilot), (walletUtil, 'session', pilot),
               (walletUtil, 'settings', KeyVal(char=KeyVal(ui=KeyVal(Get=get_setting)))),
               (walletSvc, 'walletSignals', KeyVal(on_personal_isk_balance_changed=lambda *a: None,
                                                  on_corp_isk_balance_changed=lambda *a: None))]
    missing = object()
    original = [(module, name, vars(module).get(name, missing)) for module, name, value in changes]
    rows = []
    try:
        for module, name, value in changes:
            setattr(module, name, value)
        for name, account, owner, balance, personal, corporate, role in [
            ('defaults', 'cash', pilot.charid, 51, False, False, 0),
            ('personal unchanged', 'cash', pilot.charid, 50, True, False, 0),
            ('personal null', 'cash', pilot.charid, None, True, False, 0),
            ('other owner', 'cash', 140000003, 51, True, True, 0),
            ('other division', 'cash2', pilot.corpid, 51, False, True, walletConst.corpWalletRoles[1000]),
            ('eligible division', 'cash2', pilot.corpid, 51, False, True, walletConst.corpWalletRoles[1001]),
            ('corporation disabled', 'cash2', pilot.corpid, 51, True, False, walletConst.corpWalletRoles[1001]),
        ]:
            values.update(notifyAccountChange=personal, notifyAccountChangeCorp=corporate)
            pilot.corprole = role
            del events[:]
            walletSvc.WalletSvc.OnAccountChange.__func__(Wallet(), account, owner, balance)
            rows.append(dict(name=name, events=list(events)))
        return dict(station=station_id, rows=rows,
                    label=GetByLabel(walletConst.SETTING_LABELS['notifyAccountChange']),
                    corporation=GetByLabel('UI/Wallet/WalletWindow/CorporationWallet'))
    finally:
        for module, name, value in original:
            if value is missing:
                delattr(module, name)
            else:
                setattr(module, name, value)


result = observe()
