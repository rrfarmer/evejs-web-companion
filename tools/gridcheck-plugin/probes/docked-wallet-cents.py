from eveformat import isk
from eve.client.script.ui.shared.neocom.wallet import walletConst, walletUtil
from localization import GetByLabel


def observe():
    key = 'walletShowCents'
    marker = object()
    saved = settings.char.ui.Get(key, marker)
    samples = [0, 0.75, -0.75, 14, 14.0, 1234.567, -1234.567, 1939882211.6]
    try:
        rows = [{'amount': value} for value in samples]
        for enabled in (False, True):
            settings.char.ui.Set(key, enabled)
            for row in rows:
                row['withCents' if enabled else 'whole'] = walletUtil.FmtWalletCurrency(row['amount'])
                row['marketWithCents' if enabled else 'marketWhole'] = isk(row['amount'], fraction=enabled)
        return {'station': session.stationid, 'label': GetByLabel(walletConst.SETTING_LABELS[key]),
                'default': walletConst.SETTING_DEFAULTS[key], 'samples': rows}
    finally:
        if saved is marker:
            settings.char.ui.Delete(key)
        else:
            settings.char.ui.Set(key, saved)


result = observe()
