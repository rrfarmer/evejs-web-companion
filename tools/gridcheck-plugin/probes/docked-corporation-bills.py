from localization import GetByLabel, GetByMessageID
from billtypes.data import get_bill_type_ids, get_bill_type_name_id

prefix = 'UI/Wallet/WalletWindow/'
keys = ['TabBills', 'TabPayable', 'TabReceivable', 'TabAutomaticallyPaid', 'TabAutomaticPaySettings',
        'ColHeaderBillType', 'ColHeaderAmount', 'ColHeaderOwedBy', 'ColHeaderCreditor',
        'ColHeaderInterest', 'ColHeaderItemOrderID', 'HintNoTransactionsFound']
result = dict(station=session.stationid, labels=[GetByLabel(prefix + key) for key in keys],
              types=[(i, get_bill_type_name_id(i), GetByMessageID(get_bill_type_name_id(i)))
                     for i in sorted(get_bill_type_ids()) if get_bill_type_name_id(i)])

def observe_actions():
    from eve.client.script.ui.shared.neocom.wallet import walletSvc
    from eve.client.script.ui.shared.neocom.wallet.panels.corp.corpBillsAutoPaySettingsPanel import CorpBillsAutoPaySettings
    from eve.common.lib import appConst
    from utillib import KeyVal
    called = []
    def capture(method):
        return lambda *args, **kwargs: called.append((method, args, kwargs))
    bill_mgr = KeyVal(PayCorporationBill=capture('PayCorporationBill'), SendAutomaticPaySettings=capture('SendAutomaticPaySettings'))
    alliance = KeyVal(PayBill=capture('PayBill'))
    pilot = KeyVal(charid=140000003, corpid=98000000, allianceid=99000000, corprole=appConst.corpRoleAccountant, corpAccountKey=1001)
    manager = KeyVal(RemoteSvc=lambda name: bill_mgr, GetService=lambda name: alliance)
    namespace = walletSvc.__dict__
    settings_module = __import__(CorpBillsAutoPaySettings.__module__, fromlist=['CorpBillsAutoPaySettings'])
    scopes = [(namespace, dict(session=pilot, sm=manager)), (settings_module.__dict__, dict(sm=manager))]
    originals = [(where, replacement, {key: where[key] for key in replacement if key in where}) for where, replacement in scopes]
    try:
        for where, replacement, saved in originals:
            where.update(replacement)
        wallet = KeyVal(TriggerOnCorpBillsChanged=capture('OnCorpWalletBillsChanged'))
        walletSvc.WalletSvc.PayBill.im_func(wallet, KeyVal(debtorID=pilot.corpid, billID=101))
        walletSvc.WalletSvc.PayBill.im_func(wallet, KeyVal(debtorID=pilot.allianceid, billID=102))
        CorpBillsAutoPaySettings.SubmitAutomaticPaymentSettings.im_func(KeyVal(automaticPaymentSettings={pilot.corpid: {'divisionID': 1001, 2: True}}))
    finally:
        for where, replacement, saved in originals:
            for key in replacement:
                if key in saved:
                    where[key] = saved[key]
                else:
                    where.pop(key, None)
    return called

result['actions'] = observe_actions()
