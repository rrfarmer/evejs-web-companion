import datetime
import uuid
from carbonui.util.bunch import Bunch
from jobboard.client.features.mercenary_tactical_operations.job import MTOJob
from jobboard.client.provider_type import ProviderType, get_job_id
from localization import GetByLabel

class SampleRepository(object):
    def get_mercenary_den_activity_for_character(self, identifier):
        return Bunch(expiry=datetime.datetime.utcnow() + datetime.timedelta(hours=1))

operation = object.__new__(MTOJob)
operation._activity_id = uuid.UUID('00000000-0000-4000-8000-000000000001')
operation._is_completed = False
operation._repository = SampleRepository()
provider = ProviderType.MERCENARY_TACTICAL_OPS
result = dict(station=session.stationid, provider=provider,
              job=get_job_id(provider, operation._activity_id),
              trackable=operation.is_trackable, active=operation.is_available_in_active,
              track=GetByLabel('UI/Common/Track'), untrack=GetByLabel('UI/Common/Untrack'),
              view=GetByLabel('UI/Opportunities/ViewOpportunity'))
