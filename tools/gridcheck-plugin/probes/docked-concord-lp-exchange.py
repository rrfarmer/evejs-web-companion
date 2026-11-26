from eve.client.script.ui.station.loyaltyPointStore.lpExchangeDialog import LPExhangeDialog
from eve.common.lib import appConst
from localization import GetByLabel
from npcs.npccorporations import get_corporation_exchange_rates
from utillib import KeyVal


def observe():
    rates = get_corporation_exchange_rates(appConst.ownerCONCORD, default={})
    sample = {}
    fields = ['fromCorpCostLP', 'fromCorpFinalLP', 'toCorpCurrentLP', 'toCorpTotalLP']
    target = KeyVal(currentFromCorpLPs=101, currentToCorpLPs=12, exchangeRate=rates.get(1000035))
    if target.exchangeRate:
        for field in fields:
            setattr(target, field, KeyVal(SetText=lambda text, key=field: sample.update({key: text})))
        LPExhangeDialog.SetDetails.__func__(target, 5)
    return dict(station=session.stationid,
                source=appConst.ownerCONCORD, rates=sorted(rates.items()), sample=sample,
                title=GetByLabel('UI/LPStore/LPExchangeDialogTitle'),
                action=GetByLabel('UI/Journal/JournalWindow/Agents/ConvertConcordLoyaltyPoints'))


result = observe()
