from carbonui import uiconst
from localization import GetByLabel
from player_messaging.client.dialog_handler import TITLE_BY_DIALOG_TYPE

message = cfg.GetMessage('DeleteDesign', {}, onNotFound='raise')
result = dict(station=session.stationid, action=GetByLabel('UI/Personalization/ShipSkins/SKINR/Studio/DeleteDesign'),
              dialog='DeleteDesign', kind=message.type, title=message.title or TITLE_BY_DIALOG_TYPE.get(message.type),
              body=message.text, suppress=bool(message.suppress), options=uiconst.YESNO,
              yes=GetByLabel('UI/Common/Buttons/Yes'), no=GetByLabel('UI/Common/Buttons/No'))
