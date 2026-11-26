from appConst import corpHeraldry
from corporation.common import FLAG_MIN_ALLIANCE_MEMBERSHIP_DURATION_FOR_EM_DONATION_DEFAULT
from localization import GetByLabel

def observe():
    wallet = sm.GetService('loyaltyPointsWalletSvc')
    try:
        lp = wallet.GetAllCorporationLPBalancesExcludingEvermarks()
        em = wallet.GetCorporationEvermarkBalance()
        balances = dict(lp=lp, em=em)
    except UserError as exc:
        balances = dict(error=exc.msg)
    return dict(station=session.stationid, corporation=session.corpid,
                alliance=session.allianceid, issuer=corpHeraldry,
                minimumDays=FLAG_MIN_ALLIANCE_MEMBERSHIP_DURATION_FOR_EM_DONATION_DEFAULT,
                balances=balances, labels=[
                    GetByLabel('UI/Journal/JournalWindow/Agents/LoyaltyPoints'),
                    GetByLabel('UI/Wallet/WalletWindow/TabOverview'),
                    GetByLabel('UI/Wallet/WalletWindow/TabDonate'),
                    GetByLabel('UI/Wallet/WalletWindow/TabDonateToAlliance'),
                    GetByLabel('UI/Wallet/WalletWindow/EvermarkAmount', everMarkAmount=1234)])

result = observe()
