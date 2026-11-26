from eve.client.script.ui.shared.planet.mecDen.mercDenUiController import MercDenUiController
from localization import GetByLabel
from sovereignty.mercenaryden.client.ui.containers.statistics import StatisticsContainer
from sovereignty.mercenaryden.client.ui.containers.summary import SummaryContainer
from sovereignty.mercenaryden.client.ui.controller import MercenaryDenController

stats = StatisticsContainer
summary = SummaryContainer
percentage = GetByLabel(stats.LABEL_PATH_PERCENTAGE, percentage=25.0)
result = dict(station=session.stationid, owned=len(MercDenUiController().GetEntryInfosForMyMercDens()),
              name=GetByLabel(MercenaryDenController.LABEL_PATH_MERCENARY_DEN_NAME, typeID=85230, solarSystem='Perimeter'),
              owner=GetByLabel(summary.LABEL_PATH_OWNER), skyhook=GetByLabel(summary.LABEL_PATH_SKYHOOK_OWNER),
              missing=GetByLabel(summary.LABEL_PATH_FAILED_TO_LOAD_DATA),
              active=GetByLabel(summary.LABEL_PATH_STATE_ACTIVE), inactive=GetByLabel(summary.LABEL_PATH_STATE_INACTIVE),
              activeHint=GetByLabel(summary.LABEL_PATH_TOOLTIP_STATE_ACTIVE),
              inactiveHint=GetByLabel(summary.LABEL_PATH_TOOLTIP_STATE_INACTIVE),
              rate=GetByLabel(stats.LABEL_PATH_INFOMORPH_RATE_NAME),
              rateHint=GetByLabel(stats.LABEL_PATH_INFOMORPH_RATE_TOOLTIP),
              rateExample=GetByLabel(stats.LABEL_PATH_INFOMORPH_RATE_DATA, lower=50, upper=100),
              workforce=GetByLabel(stats.LABEL_PATH_WORKFORCE_COST_NAME), workforceExample=percentage,
              workforceHint=GetByLabel(stats.LABEL_PATH_WORKFORCE_COST_TOOLTIP, workforce_units=100,
                                       workforce_cost_percentage=percentage))
