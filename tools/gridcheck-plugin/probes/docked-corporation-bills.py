from localization import GetByLabel, GetByMessageID
from billtypes.data import get_bill_type_ids, get_bill_type_name_id

prefix = 'UI/Wallet/WalletWindow/'
keys = ['TabBills', 'TabPayable', 'TabReceivable', 'TabAutomaticallyPaid', 'TabAutomaticPaySettings',
        'ColHeaderBillType', 'ColHeaderAmount', 'ColHeaderOwedBy', 'ColHeaderCreditor',
        'ColHeaderInterest', 'ColHeaderItemOrderID', 'HintNoTransactionsFound']
result = dict(station=session.stationid, labels=[GetByLabel(prefix + key) for key in keys],
              types=[(i, get_bill_type_name_id(i), GetByMessageID(get_bill_type_name_id(i)))
                     for i in sorted(get_bill_type_ids()) if get_bill_type_name_id(i)])
