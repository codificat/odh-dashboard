import * as React from 'react';
import * as _ from 'lodash';
import { AxiosError } from 'axios';
import {
  createConfigMap,
  deleteConfigMap,
  getConfigMap,
  replaceConfigMap,
} from '../services/configMapService';
import { createSecret, deleteSecret, getSecret, replaceSecret } from '../services/secretsService';
import { createRoleBinding, getRoleBinding } from '../services/roleBindingService';
import {
  EnvVarReducedType,
  EnvVarReducedTypeKeyValues,
  EnvVarResource,
  EnvVarResourceType,
  EventStatus,
  K8sEvent,
  K8sResourceCommon,
  Notebook,
  NotebookControllerUserState,
  NotebookStatus,
  PersistentVolumeClaim,
  ResourceCreator,
  ResourceDeleter,
  ResourceGetter,
  ResourceReplacer,
  RoleBinding,
  VariableRow,
} from '../types';
import AppContext from '../app/AppContext';

export const usernameTranslate = (username: string): string =>
  username
    .replace(/-/g, '-2d')
    .replace(/@/g, '-40')
    .replace(/\./g, '-2e')
    .replace(/:/g, '-3a')
    .toLowerCase();

export const generateNotebookNameFromUsername = (username: string): string =>
  `jupyter-nb-${usernameTranslate(username)}`;

export const generatePvcNameFromUsername = (username: string): string =>
  `jupyterhub-nb-${usernameTranslate(username)}-pvc`;

export const generateEnvVarFileNameFromUsername = (username: string): string =>
  `jupyterhub-singleuser-profile-${usernameTranslate(username)}-envs`;

/**
 * Verify whether a resource is on the cluster
 * If it exists, return the resource object, else, return null
 * If the createFunc is also passed, create it when it doesn't exist
 */
export const verifyResource = async <T extends K8sResourceCommon>(
  name: string,
  namespace: string,
  fetchFunc: ResourceGetter<T>,
  createFunc?: ResourceCreator<T>,
  createBody?: T,
): Promise<T | undefined> => {
  return await fetchFunc(namespace, name).catch(async (e: AxiosError) => {
    if (e.response?.status === 404) {
      if (createFunc && createBody) {
        return await createFunc(createBody);
      } else {
        return undefined;
      }
    }
    throw e;
  });
};

/** Classify environment variables as ConfigMap or Secret */
export const classifyEnvVars = (variableRows: VariableRow[]): EnvVarReducedTypeKeyValues => {
  return variableRows.reduce(
    (prev, curr) => {
      const vars: Record<string, string | number> = {};
      const secretVars: Record<string, string | number> = {};
      curr.variables.forEach((variable) => {
        if (variable.type === 'text') {
          vars[variable.name] = variable.value;
        } else {
          secretVars[variable.name] = variable.value;
        }
      });
      return {
        configMap: { ...prev.configMap, ...vars },
        secrets: { ...prev.secrets, ...secretVars },
      };
    },
    { configMap: {}, secrets: {} },
  );
};

/** Check whether to get, create, replace or delete the environment variable files (Secret and ConfigMap) */
export const verifyEnvVars = async (
  name: string,
  namespace: string,
  kind: string,
  envVars: Record<string, string>,
  fetchFunc: ResourceGetter<EnvVarResource>,
  createFunc: ResourceCreator<EnvVarResource>,
  replaceFunc: ResourceReplacer<EnvVarResource>,
  deleteFunc: ResourceDeleter,
): Promise<void> => {
  if (!envVars) {
    const resource = await verifyResource(name, namespace, fetchFunc);
    if (resource) {
      await deleteFunc(namespace, name);
    }
    return;
  }

  const body =
    kind === EnvVarResourceType.Secret
      ? {
          stringData: envVars,
          type: 'Opaque',
        }
      : {
          data: envVars,
        };
  const newResource: EnvVarResource = {
    apiVersion: 'v1',
    kind,
    metadata: {
      name,
      namespace,
    },
    ...body,
  };
  const response = await verifyResource<EnvVarResource>(
    name,
    namespace,
    fetchFunc,
    createFunc,
    newResource,
  );
  if (!_.isEqual(response?.data, envVars)) {
    await replaceFunc(newResource);
  }
};

/** Update the config map and secret file on the cluster */
export const checkEnvVarFile = async (
  username: string,
  namespace: string,
  variableRows: VariableRow[],
): Promise<EnvVarReducedType> => {
  const envVarFileName = generateEnvVarFileNameFromUsername(username);
  const envVars = classifyEnvVars(variableRows);
  await verifyEnvVars(
    envVarFileName,
    namespace,
    EnvVarResourceType.Secret,
    envVars.secrets,
    getSecret,
    createSecret,
    replaceSecret,
    deleteSecret,
  );
  await verifyEnvVars(
    envVarFileName,
    namespace,
    EnvVarResourceType.ConfigMap,
    envVars.configMap,
    getConfigMap,
    createConfigMap,
    replaceConfigMap,
    deleteConfigMap,
  );
  return { envVarFileName, ...envVars };
};

export const generatePvc = (
  pvcName: string,
  namespace: string,
  pvcSize: string,
): PersistentVolumeClaim => ({
  apiVersion: 'v1',
  kind: 'PersistentVolumeClaim',
  metadata: {
    name: pvcName,
    namespace,
  },
  spec: {
    accessModes: ['ReadWriteOnce'],
    resources: {
      requests: {
        storage: pvcSize,
      },
    },
    volumeMode: 'Filesystem',
  },
  status: {
    phase: 'Pending',
  },
});

export const checkNotebookRunning = (notebook?: Notebook): boolean =>
  !!(
    notebook?.status?.readyReplicas &&
    notebook?.status?.readyReplicas >= 1 &&
    notebook?.metadata.annotations?.['opendatahub.io/link']
  );

export const getUserStateFromDashboardConfig = (
  translatedUsername: string,
  notebookControllerState: NotebookControllerUserState[],
): NotebookControllerUserState | undefined =>
  notebookControllerState.find((state) => usernameTranslate(state.user) === translatedUsername);

export const useGetUserStateFromDashboardConfig = (): ((
  username: string,
) => NotebookControllerUserState | undefined) => {
  const { dashboardConfig } = React.useContext(AppContext);

  return React.useCallback(
    (username: string) =>
      getUserStateFromDashboardConfig(
        username,
        dashboardConfig.status?.notebookControllerState || [],
      ),
    [dashboardConfig],
  );
};

/** Check whether the namespace of the notebooks has the access to image streams
 * If not, create the rolebinding
 */
export const validateNotebookNamespaceRoleBinding = async (
  notebookNamespace: string,
  dashboardNamespace: string,
): Promise<RoleBinding | undefined> => {
  const roleBindingName = `${notebookNamespace}-image-pullers`;
  const roleBindingObject: RoleBinding = {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: {
      name: roleBindingName,
      namespace: dashboardNamespace,
    },
    roleRef: {
      apiGroup: 'rbac.authorization.k8s.io',
      kind: 'ClusterRole',
      name: 'system:image-puller',
    },
    subjects: [
      {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'Group',
        name: `system:serviceaccounts:${notebookNamespace}`,
      },
    ],
  };
  return await verifyResource<RoleBinding>(
    roleBindingName,
    dashboardNamespace,
    getRoleBinding,
    createRoleBinding,
    roleBindingObject,
  );
};

export const getNotebookStatus = (events: K8sEvent[], time: Date): NotebookStatus | null => {
  const filteredEvents = events.filter((event) => new Date(event.lastTimestamp) > time);
  if (filteredEvents.length === 0) {
    return null;
  }
  let percentile = 0;
  let status: EventStatus = EventStatus.IN_PROGRESS;
  const lastItem = filteredEvents[filteredEvents.length - 1];
  let currentEvent = '';
  if (lastItem.message.includes('oauth-proxy')) {
    switch (lastItem.reason) {
      case 'Pulling': {
        currentEvent = 'Pulling oauth proxy';
        percentile = 72;
        break;
      }
      case 'Pulled': {
        currentEvent = 'Oauth proxy pulled';
        percentile = 80;
        break;
      }
      case 'Created': {
        currentEvent = 'Oauth proxy container created';
        percentile = 88;
        break;
      }
      case 'Started': {
        currentEvent = 'Oauth proxy container started';
        percentile = 96;
        break;
      }
      default: {
        currentEvent = 'Error creating oauth proxy container';
        status = EventStatus.ERROR;
      }
    }
  } else {
    switch (lastItem.reason) {
      case 'SuccessfulCreate': {
        currentEvent = 'Pod created';
        percentile = 8;
        break;
      }
      case 'Scheduled': {
        currentEvent = 'Pod assigned';
        percentile = 16;
        break;
      }
      case 'SuccessfulAttachVolume': {
        currentEvent = 'PVC attached';
        percentile = 24;
        break;
      }
      case 'AddedInterface': {
        currentEvent = 'Interface added';
        percentile = 32;
        break;
      }
      case 'Pulling': {
        currentEvent = 'Pulling notebook image';
        percentile = 40;
        break;
      }
      case 'Pulled': {
        currentEvent = 'Notebook image pulled';
        percentile = 48;
        break;
      }
      case 'Created': {
        currentEvent = 'Notebook container created';
        percentile = 56;
        break;
      }
      case 'Started': {
        currentEvent = 'Notebook container started';
        percentile = 64;
        break;
      }
      default: {
        currentEvent = 'Error creating notebook container';
        status = EventStatus.ERROR;
      }
    }
  }
  return {
    percentile,
    currentEvent,
    currentEventReason: lastItem.reason,
    currentEventDescription: lastItem.message,
    currentStatus: status,
    events: filteredEvents,
  };
};
