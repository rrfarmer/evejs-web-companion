from eve.client.script.ui.shared.neocom.wallet import walletConst, walletSvc, walletUtil
from eve.common.lib import appConst
from localization import GetByLabel
from utillib import KeyVal


def observe():
    station_id = session.stationid
    pilot = KeyVal(charid=session.charid, corpid=session.corpid, corprole=0)
    calls = []
    preferences = {}

    class Services(object):
        def GetService(self, name):
            return self

        def Blink(self, window, hint):
            calls.append([window, hint])

    class Wallet(object):
        _OnShareChangeChar = walletSvc.WalletSvc._OnShareChangeChar.__func__
        _OnShareChangeCorp = walletSvc.WalletSvc._OnShareChangeCorp.__func__

    def read_setting(name, fallback):
        return preferences.get(name, fallback)

    changes = [(walletSvc, 'sm', Services()), (walletSvc, 'session', pilot), (walletUtil, 'session', pilot),
               (walletUtil, 'settings', KeyVal(char=KeyVal(ui=KeyVal(Get=read_setting))))]
    missing = object()
    original = [(module, key, vars(module).get(key, missing)) for module, key, value in changes]
    cases = [
        ('personal default', pilot.charid, 98000001, 0, {}),
        ('corporation holder', pilot.corpid, 98000001, walletConst.corpWalletRoles[1000], {}),
        ('corporation issuer', 140000003, pilot.corpid, appConst.corpRoleJuniorAccountant, {}),
        ('corporation no access', pilot.corpid, 98000001, 0, {}),
        ('other owners', 140000003, 98000001, appConst.corpRoleAccountant, {}),
        ('personal precedence', pilot.charid, pilot.corpid, appConst.corpRoleAccountant,
         {'notifyShareChange': False}),
        ('corporation disabled', pilot.corpid, 98000001, walletConst.corpWalletRoles[1000],
         {'notifyShareChangeCorp': False}),
    ]
    rows = []
    try:
        for module, key, value in changes:
            setattr(module, key, value)
        for name, shareholder_id, issuer_id, role, enabled in cases:
            pilot.corprole = role
            preferences.clear()
            preferences.update(enabled)
            del calls[:]
            walletSvc.WalletSvc.OnShareChange.__func__(Wallet(), shareholder_id, issuer_id, {})
            rows.append(dict(name=name, calls=list(calls)))
        return dict(station=station_id, rows=rows,
                    label=GetByLabel(walletConst.SETTING_LABELS['notifyShareChange']))
    finally:
        for module, key, value in original:
            if value is missing:
                delattr(module, key)
            else:
                setattr(module, key, value)


result = observe()
