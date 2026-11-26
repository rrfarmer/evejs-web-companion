from eve.client.script.ui.shared.neocom.neocom import neocomTooltips
from eve.client.script.ui.shared.neocom.wallet import walletConst, walletUtil
from utillib import KeyVal


class Tooltip(object):
    def __init__(self):
        self.rows = []

    def AddLabelValue(self, label, value):
        self.rows.append([label, value])


def observe():
    station_id = session.stationid
    actual = Tooltip()
    neocomTooltips.LoadTooltipPanel(actual, KeyVal(id='wallet'))
    personal = 1939882211.6
    balances = {1000: 3400.45, 1001: 1234.567}
    calls = []
    case = KeyVal(fractions=False)

    class Wallet(object):
        def GetWealth(self):
            return personal

        def GetCorpWealthCached1Min(self, key):
            calls.append(key)
            return balances[key]

    class Services(object):
        def GetService(self, name):
            return Wallet()

    def get_setting(key, fallback):
        return case.fractions if key == 'walletShowCents' else fallback

    changes = [
        (neocomTooltips, 'sm', Services()),
        (neocomTooltips, 'session', case),
        (neocomTooltips, 'settings', KeyVal(char=KeyVal(ui=KeyVal(Get=get_setting)))),
        (walletUtil, 'session', case),
    ]
    missing = object()
    original = [(module, name, vars(module).get(name, missing)) for module, name, value in changes]
    cases = [('personal', None, 0, False),
             ('other division', 1001, walletConst.corpWalletRoles[1000], False),
             ('active division', 1001, walletConst.corpWalletRoles[1001], False),
             ('show cents', 1001, walletConst.corpWalletRoles[1001], True),
             ('master division', 1000, walletConst.corpWalletRoles[1000], True)]
    readings = []
    try:
        for module, name, value in changes:
            setattr(module, name, value)
        for name, key, role, fractions in cases:
            case.corpAccountKey, case.corprole, case.fractions = key, role, fractions
            del calls[:]
            tooltip = Tooltip()
            neocomTooltips.LoadTooltipPanel(tooltip, KeyVal(id='wallet'))
            readings.append(dict(name=name, key=key, role=str(role), fractions=fractions,
                                 rows=tooltip.rows, corporationReads=list(calls)))
        other = Tooltip()
        neocomTooltips.LoadTooltipPanel(other, KeyVal(id='inventory'))
        return dict(station=station_id, actual=actual.rows, personal=personal, balances=balances,
                    cases=readings, other=other.rows)
    finally:
        for module, name, value in original:
            if value is missing:
                delattr(module, name)
            else:
                setattr(module, name, value)


result = observe()
