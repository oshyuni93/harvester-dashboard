
import { SCHEMA } from '@shell/config/types';

import { matches } from '@shell/utils/selector';
import { typeMunge, typeRef, SIMPLE_TYPES } from '@shell/utils/create-yaml';
import Resource from '@shell/plugins/dashboard-store/resource-class';
import mutations from './mutations';
import { keyFieldFor, normalizeType } from './normalize';
import { lookup } from './model-loader';
import garbageCollect from '@shell/utils/gc/gc';

export const urlFor = (state, getters) => (type, id, opt) => {
  opt = opt || {};
  type = getters.normalizeType(type);
  let url = opt.url;

  if ( !url ) {
    const schema = getters.schemaFor(type);

    if ( !schema ) {
      throw new Error(`Unknown schema for type: ${ type }`);
    }

    url = schema.links.collection;

    if ( !url ) {
      throw new Error(`You don't have permission to list this type: ${ type }`);
    }

    if ( id ) {
      url += `/${ id }`;
    }
  }

  if ( !url.startsWith('/') && !url.startsWith('http') ) {
    const baseUrl = state.config.baseUrl.replace(/\/$/, '');

    url = `${ baseUrl }/${ url }`;
  }

  url = getters.urlOptions(url, opt);

  return url;
};

export default {

  all: (state, getters, rootState) => (type) => {
    type = getters.normalizeType(type);

    if ( !getters.typeRegistered(type) ) {
      // Yes this is mutating state in a getter... it's not the end of the world..
      // throw new Error(`All of ${ type } is not loaded`);
      console.warn(`All of ${ type } is not loaded yet`); // eslint-disable-line no-console
      mutations.registerType(state, type);
    }

    garbageCollect.gcUpdateLastAccessed({
      state, getters, rootState
    }, type);

    return state.types[type].list;
  },

  matching: (state, getters, rootState) => (type, selector, namespace) => {
    let all = getters['all'](type);

    // Filter first by namespace if one is provided, since this is efficient
    if (namespace) {
      all = all.filter(obj => obj.namespace === namespace);
    }

    garbageCollect.gcUpdateLastAccessed({
      state, getters, rootState
    }, type);

    return all.filter((obj) => {
      return matches(obj, selector);
    });
  },

  byId: (state, getters, rootState) => (type, id) => {
    type = getters.normalizeType(type);
    const entry = state.types[type];

    if ( entry ) {
      garbageCollect.gcUpdateLastAccessed({
        state, getters, rootState
      }, type);

      return entry.map.get(id);
    }
  },

  /**
   * Checks a schema for the given path
   *
   * Given that schema are primarily a rancher thing most logic is in the `steve` store
   */
  pathExistsInSchema: (state, getters) => (type, path) => {
    return false;
  },

  // @TODO resolve difference between this and schemaFor and have only one of them.
  schema: (state, getters) => (type) => {
    type = getters.normalizeType(type);
    const schemas = state.types[SCHEMA];
    const keyField = getters.keyFieldForType(SCHEMA);

    return schemas.list.find((x) => {
      const thisOne = getters.normalizeType(x[keyField]);

      return thisOne === type || thisOne.endsWith(`.${ type }`);
    });
  },

  // Fuzzy search to find a matching schema name for plugins/lookup
  schemaName: (state, getters) => (type) => {
    type = getters.normalizeType(type);
    const schemas = state.types[SCHEMA];
    const keyField = getters.keyFieldForType(SCHEMA);
    const res = schemas.list.find((x) => {
      const thisOne = getters.normalizeType(x[keyField]);

      return thisOne === type || thisOne.endsWith(`.${ type }`);
    });

    if (!res) {
      return;
    }
    const arrayRes = Array.isArray(res) ? res : [res];
    const entries = arrayRes.map((x) => {
      return x[keyField];
    }).sort((a, b) => {
      return a.length - b.length;
    });

    if ( entries[0] ) {
      return entries[0];
    }

    return type;
  },

  // Fuzzy is only for plugins/lookup, do not use in real code
  schemaFor: (state, getters) => (type, fuzzy = false, allowThrow = true) => {
    const schemas = state.types[SCHEMA];

    type = getters.normalizeType(type);

    if ( !schemas ) {
      if ( allowThrow ) {
        throw new Error("Schemas aren't loaded yet");
      } else {
        return null;
      }
    }

    const out = schemas.map.get(type);

    if ( !out && fuzzy ) {
      const close = getters.schemaName(type);

      if ( close ) {
        return getters.schemaFor(close);
      }
    }

    return out;
  },

  defaultFor: (state, getters) => (type, rootSchema, schemaDefinitions = null) => {
    let resourceFields;

    if (!schemaDefinitions) {
      // Depth 0. Get the schemaDefinitions that will contain the child schema resourceFields for recursive calls

      schemaDefinitions = rootSchema.schemaDefinitions || {}; // norman...
      resourceFields = rootSchema.resourceFields || {};
    } else if (rootSchema.requiresResourceFields) {
      resourceFields = schemaDefinitions[type]?.resourceFields || {};
    } else {
      const schema = getters['schemaFor'](type);

      resourceFields = schema?.resourceFields || {};
    }

    const out = {};

    for ( const key in resourceFields ) {
      const field = resourceFields[key];

      if ( !field ) {
        // Not much to do here...
        continue;
      }

      const type = typeMunge(field.type);
      const mapOf = typeRef('map', type, field);
      const arrayOf = typeRef('array', type, field);
      const referenceTo = typeRef('reference', type);

      if ( mapOf || type === 'map' || type === 'json' ) {
        out[key] = getters.defaultFor(type, rootSchema, schemaDefinitions);
      } else if ( arrayOf || type === 'array' ) {
        out[key] = [];
      } else if ( referenceTo ) {
        out[key] = undefined;
      } else if ( SIMPLE_TYPES.includes(type) ) {
        if ( typeof field['default'] === 'undefined' ) {
          out[key] = undefined;
        } else {
          out[key] = field['default'];
        }
      } else {
        out[key] = getters.defaultFor(type, rootSchema, schemaDefinitions);
      }
    }

    return out;
  },

  canList: (state, getters) => (type) => {
    const schema = getters.schemaFor(type);

    return schema && schema.hasLink('collection');
  },

  typeRegistered: (state, getters) => (type) => {
    type = getters.normalizeType(type);

    return !!state.types[type];
  },

  typeEntry: (state, getters) => (type) => {
    type = getters.normalizeType(type);

    return state.types[type];
  },

  haveAll: (state, getters) => (type) => {
    type = getters.normalizeType(type);
    const entry = state.types[type];

    if ( entry ) {
      return entry.haveAll || false;
    }

    return false;
  },

  haveAllNamespace: (state, getters) => (type, namespace) => {
    if (!namespace) {
      return false;
    }

    type = getters.normalizeType(type);
    const entry = state.types[type];

    if ( entry ) {
      return entry.haveNamespace === namespace;
    }

    return false;
  },

  haveNamespace: (state, getters) => (type) => {
    type = getters.normalizeType(type);

    return state.types[type]?.haveNamespace || null;
  },

  haveSelector: (state, getters) => (type, selector) => {
    type = getters.normalizeType(type);
    const entry = state.types[type];

    if ( entry ) {
      return entry.haveSelector[selector] || false;
    }

    return false;
  },

  normalizeType: () => (type) => {
    return normalizeType(type);
  },

  keyFieldForType: () => (type) => {
    return keyFieldFor(type);
  },

  urlFor,

  urlOptions: () => (url, opt) => {
    return url;
  },

  storeName: (state) => {
    return state.config.namespace;
  },

  defaultModel: () => () => {
    return undefined;
  },

  classify: (state, getters, rootState) => (obj) => {
    return lookup(state.config.namespace, obj?.type, obj?.metadata?.name, rootState) || Resource;
  },

  cleanResource: () => (existing, data) => {
    return data;
  },

  isClusterStore: (state) => {
    return state.config.isClusterStore;
  },

  // Increment the load counter for a resource type
  // This is used for incremental loading do detect when a page changes occur of the a reload happend
  // While a previous incremental loading operation is still in progress
  loadCounter: (state, getters) => (type) => {
    type = getters.normalizeType(type);

    if (!!state.types[type]) {
      return state.types[type].loadCounter;
    }

    return 0;
  },

  gcIgnoreTypes: () => {
    return {};
  }
};
