# Probe the native Industry button predicate with one accessible service at a time.
import structures
from eve.client.script.ui.services.structure.structureServices import StructureServices


class ServiceSnapshot(object):
    def __init__(self, service_ids):
        self.onlineServices = dict((service_id, 0.0) for service_id in service_ids)

    def CharacterGetServices(self, structure_id):
        return self.onlineServices


def industry_available(service_ids):
    return bool(StructureServices.IsServiceAvailableForCharacter.im_func(
        ServiceSnapshot(service_ids), structures.SERVICE_INDUSTRY))


cases = [sorted([service_id]) for service_id in structures.SERVICES if service_id > 0]
result = {'build': 3698585, 'industry': sorted(structures.INDUSTRY_SERVICES),
          'cases': [[ids, industry_available(ids)] for ids in [[]] + sorted(cases)]}
