from eve.client.script.ui.shared.neocom.wallet.panels.personal.personalDonateLPPanel import PersonalDonateLPPanel
from eve.client.script.ui.util.searchUtil import SearchCorporations
from eve.common.script.search.const import MatchBy
from localization import GetByLabel
from utillib import KeyVal


def observe():
    wallet = sm.GetService('loyaltyPointsWalletSvc')
    panel = PersonalDonateLPPanel
    live = SearchCorporations('Caldari Navy', searchBy=MatchBy.exact_phrase_only)
    valid = panel._filter_valid_corps.__func__(KeyVal(_can_make_donations=True), live)
    mock = KeyVal(_selected_corp_id=1000035, _selected_issuer_corp_id=1000125)
    confirmation = panel._get_confirmation_message.__func__(mock, 1234)
    labels = ['UI/Wallet/WalletWindow/TabDonate', 'UI/Wallet/WalletWindow/TransferTo',
              'UI/Common/SearchBy', 'UI/Common/Corporation', 'UI/Wallet/WalletWindow/GiveAmount',
              'UI/HangarTransfer/TransferBtn', 'UI/Wallet/WalletWindow/TransferSuccessful']
    return dict(station=session.stationid, balances=list(wallet.GetAllCharacterLPBalancesExcludingEvermarks()),
                npcMatches=[row.charID for row in live], eligibleMatches=[row.charID for row in valid],
                labels=[GetByLabel(label) for label in labels], confirmation=confirmation,
                killswitchDefault=panel.killSwitchDefault)


result = observe()
