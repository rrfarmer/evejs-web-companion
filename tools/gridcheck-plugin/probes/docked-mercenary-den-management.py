from localization import GetByLabel
from sovereignty.mercenaryden.client.ui.containers.activities import ActivitiesContainer
from sovereignty.mercenaryden.client.ui.containers.activity_cards import ActivityCards
from sovereignty.mercenaryden.client.ui.containers.evolution_title import AnarchyTitleContainer, DevelopmentTitleContainer
from sovereignty.mercenaryden.client.ui.containers.evolution_value import AnarchyValueContainer, DevelopmentValueContainer
from sovereignty.mercenaryden.client.ui.containers.management import ManagementContainerWithTabs

tabs = ManagementContainerWithTabs
result = dict(station=session.stationid, evolution=GetByLabel(tabs.LABEL_PATH_TAB_EVOLUTION),
              activities=GetByLabel(tabs.LABEL_PATH_TAB_ACTIVITIES),
              activityTitle=GetByLabel(ActivitiesContainer.LABEL_PATH_TITLE),
              activityHint=GetByLabel(ActivitiesContainer.LABEL_PATH_TOOLTIP),
              nextActivity=GetByLabel(ActivityCards.LABEL_PATH_NEXT_ACTIVITY, time_left='5m'),
              ready=GetByLabel('UI/Agency/MercDen/ReadyToStart'), started=GetByLabel('UI/Agency/MercDen/InProgress'),
              development=GetByLabel(DevelopmentTitleContainer.LABEL_PATH_TITLE),
              anarchy=GetByLabel(AnarchyTitleContainer.LABEL_PATH_TITLE),
              developmentValue=GetByLabel(DevelopmentValueContainer.LABEL_PATH_VALUE, level=0),
              anarchyValue=GetByLabel(AnarchyValueContainer.LABEL_PATH_VALUE, level=0))
