import blue
from corporation.common import FLAG_MIN_ALLIANCE_MEMBERSHIP_DURATION_FOR_EM_DONATION as MIN_DAYS
from corporation.common import FLAG_MIN_ALLIANCE_MEMBERSHIP_DURATION_FOR_EM_DONATION_DEFAULT as DEFAULT_DAYS
from eve.client.script.ui.shared.neocom.wallet.panels.personal.personalDonateEMPanel import PersonalDonateEMPanel
from eve.common.lib import appConst
from eve.common.script.sys import idCheckers
from featuremanagement.client.flag import flag_int
from localization import GetByLabel
from utillib import KeyVal


def observe():
    days = flag_int(MIN_DAYS, DEFAULT_DAYS)()
    info = sm.RemoteSvc('charMgr').GetPrivateInfoOnCorpChange(session.charid)
    selected = KeyVal(_selected_corp_id=session.corpid)
    return dict(station=session.stationid, corporation=session.corpid,
                playerCorp=bool(idCheckers.IsPlayerCorporation(session.corpid)),
                daysInCorp=(blue.os.GetWallclockTime() - info.corporationDateTime) / appConst.DAY if info else None,
                days=days, defaultDays=DEFAULT_DAYS,
                restrictedTitle=GetByLabel('UI/Wallet/WalletWindow/AccessRestricted'),
                restricted=GetByLabel('UI/Wallet/WalletWindow/PersonalEMTabRestricted', numDays=days),
                notice=GetByLabel('UI/Wallet/WalletWindow/TransferPersonalEMNotice', numDaysCorp=days, numDaysAlliance=days),
                confirmation=PersonalDonateEMPanel._get_confirmation_message.__func__(selected, 1234))


result = observe()
