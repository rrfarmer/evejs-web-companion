from eve.client.script.ui.shared.planet.mecDen.mercDenWnd import MyMercDensWnd
from eve.client.script.ui.shared.planet.mecDen.mercDenEntry import MerDenEntry
from eve.client.script.ui.shared.planet.mecDen.mercDenUiController import MercDenUiController
from localization import GetByLabel

path = 'UI/Sovereignty/MercenaryDen/MyMercenaryDensWindow/'
controller = MercDenUiController()
owned = controller.GetEntryInfosForMyMercDens()
result = dict(station=session.stationid, title=GetByLabel(MyMercDensWnd.default_captionLabelPath),
              columns=MerDenEntry.GetHeaders(), deployed=GetByLabel(path + 'DeployedDens'),
              empty=GetByLabel(path + 'NoDensMessage'), agency=GetByLabel(path + 'OpenAgencyButton'),
              owned=len(owned), maximum=controller.myMaxDenNum,
              absolute=controller.absoluteMaxDenNum, count=controller.GetDeployedDensText(len(owned)))
