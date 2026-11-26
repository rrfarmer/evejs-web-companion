from eve.client.script.ui.shared.neocom.wallet import walletConst, walletSvc, walletUtil
from eve.common.lib import appConst
from localization import GetByLabel
from utillib import KeyVal


def observe():
    station_id = session.stationid
    member = KeyVal(corprole=0)
    preferences = {}
    notices = []
    refreshes = []

    class Services(object):
        def GetService(self, name):
            return self

        def Blink(self, window, hint):
            notices.append([window, hint])

        def ScatterEvent(self, event):
            refreshes.append(event)

    class Wallet(object):
        TriggerOnCorpBillsChanged = walletSvc.WalletSvc.TriggerOnCorpBillsChanged.__func__

    def get_setting(name, default):
        return preferences.get(name, default)

    changes = [(walletSvc, 'sm', Services()), (walletUtil, 'session', member),
               (walletUtil, 'settings', KeyVal(char=KeyVal(ui=KeyVal(Get=get_setting))))]
    missing = object()
    original = [(module, key, vars(module).get(key, missing)) for module, key, value in changes]
    rows = []
    cases = [
        ('no wallet role', 0, None),
        ('director bit alone', appConst.corpRoleDirector, None),
        ('accountant', appConst.corpRoleAccountant, None),
        ('junior accountant', appConst.corpRoleJuniorAccountant, None),
        ('division access', walletConst.corpWalletRoles[1006], None),
        ('preference off', appConst.corpRoleAccountant, False),
    ]
    try:
        for module, key, value in changes:
            setattr(module, key, value)
        for name, role, preference in cases:
            member.corprole = role
            preferences.clear()
            if preference is not None:
                preferences['notifyBillChange'] = preference
            del notices[:]
            del refreshes[:]
            walletSvc.WalletSvc.OnBillReceived.__func__(Wallet())
            rows.append(dict(name=name, role=str(role), preference=preference,
                             notices=list(notices), refreshes=list(refreshes)))
        return dict(station=station_id, rows=rows,
                    label=GetByLabel(walletConst.SETTING_LABELS['notifyBillChange']))
    finally:
        for module, key, value in original:
            if value is missing:
                delattr(module, key)
            else:
                setattr(module, key, value)


result = observe()
