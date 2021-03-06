//@flow

import {getGraph, bind} from './stdlib'
import {Defer} from './defer'
import {watchUnit} from './watch'

import {is, step, launch, createNode} from 'effector'

const stack = []

/**
hydrate state on client

const root = createDomain()
hydrate(root, {
  values: window.__initialState__
})

*/
export function hydrate(domain, {values}) {
  if (!is.domain(domain)) {
    throw Error('first argument of hydrate should be domain')
  }
  if (Object(values) !== values) {
    throw Error('values property should be an object')
  }
  const valuesSidList = Object.getOwnPropertyNames(values)
  domain.onCreateStore(store => {
    if (store.sid && valuesSidList.includes(store.sid)) {
      store.setState(values[store.sid])
    }
  })
}

/**
serialize state on server

const scope = createScope({domain, start})
const alice = await fork(scope, {ctx})
const state = serialize(alice)
*/
export function serialize(scope) {
  const result = {}
  const root = scope.getDomain()
  for (const store of root.history.stores) {
    if (!store.sid) {
      throw Error(
        'expect store to have sid (need to add "effector/babel-plugin" to babel plugins)',
      )
    }
    const state = scope.find(store).meta.wrapped.getState()
    result[store.sid] = state
  }

  return result
}

/** invoke event in scope */
export function invoke(unit, payload) {
  if (stack.length === 0) {
    throw Error('invoke cannot be called outside of forked .watch')
  }
  launch(stack[stack.length - 1](unit), payload)
}

/** bind event to scope */
export function scopeBind(unit) {
  if (stack.length === 0) {
    throw Error('scopeBind cannot be called outside of forked .watch')
  }
  const result = stack[stack.length - 1](unit)
  return payload => {
    launch(result, payload)
  }
}

export function fork(domain, {ctx, start}) {
  if (!is.domain(domain))
    return Promise.reject(Error('first argument of fork should be domain'))
  if (!domain.graphite.meta.withScopes) {
    domain.graphite.meta.withScopes = true
    domain.onCreateEvent(event => {
      event.create = payload => {
        if (stack.length > 0) {
          invoke(event, payload)
        } else {
          launch(event, payload)
        }
        return payload
      }
    })
    domain.onCreateEffect(effect => {
      effect.create = params => {
        const req = new Defer()
        const payload = {ɔ: {params, req}}
        if (stack.length > 0) {
          invoke(effect, payload)
        } else {
          launch(effect, payload)
        }
        return req.req
      }
    })
  }
  const {scope, req, syncComplete} = cloneGraph(domain)
  if (start) {
    launch(scope.find(start), ctx)
  }
  syncComplete()
  return req.then(() => scope)
}

/**
everything we need to clone graph section
reachable from given unit

to erase, call clearNode(clone.node)
*/
function cloneGraph(parentUnit) {
  const unit = getGraph(parentUnit)
  const list = []
  ;(function traverse(node) {
    if (list.includes(node)) return
    list.push(node)
    forEachRelatedNode(node, traverse)
  })(unit)
  const refs = new Map()

  const defer = new Defer()
  const fxCount = {
    current: 0,
    syncComplete: false,
  }
  let fxID = 0

  let tryCompleteInitPhase = () => {
    if (!fxCount.syncComplete) return
    if (fxCount.current !== 0) return
    const id = fxID
    Promise.resolve().then(() => {
      if (id !== fxID) return
      tryCompleteInitPhase = null
      defer.rs()
    })
  }
  const completeInitPhase = () => {
    if (fxCount.current === 0) {
      fxID += 1
      tryCompleteInitPhase && tryCompleteInitPhase()
    }
  }
  const clones = list.map(node => {
    const result = createNode({
      node: node.seq.map(step => ({
        id: step.id,
        type: step.type,
        data: Object.assign({}, step.data),
        hasRef: step.hasRef,
      })),
      child: [...node.next],
      meta: Object.assign({}, node.meta),
      scope: Object.assign({}, node.scope),
    })
    result.family = {
      type: node.family.type,
      links: [...node.family.links],
      owners: [...node.family.owners],
    }
    return result
  })
  clones.forEach(node => {
    const {
      reg,
      scope,
      meta: {onCopy, op, unit},
    } = node
    const itemTag = op || unit
    for (const id in reg) {
      const ref = reg[id]
      let newRef = refs.get(ref)
      if (!newRef) {
        newRef = {
          id: ref.id,
          current: ref.current,
        }
        refs.set(ref, newRef)
      }
      reg[id] = newRef
    }
    if (onCopy) {
      for (let j = 0; j < onCopy.length; j++) {
        scope[onCopy[j]] = findClone(scope[onCopy[j]])
      }
    }
    forEachRelatedNode(node, (node, i, siblings) => {
      if (!node.meta.fork) siblings[i] = findClone(node)
    })
    switch (itemTag) {
      case 'store':
        node.meta.wrapped = wrapStore(node)
        break
      case 'watch': {
        const handler = scope.fn
        scope.fn = data => {
          stack.push(findClone)
          try {
            handler(data)
          } finally {
            stack.pop()
          }
        }
        break
      }
      case 'effect':
        node.seq.push(
          step.compute({
            fn(upd) {
              fxCount.current += 1
              fxID += 1
              return upd
            },
          }),
        )
        createNode({
          meta: {fork: true},
          node: [
            step.run({
              fn() {
                fxCount.current -= 1
                completeInitPhase()
              },
            }),
          ],
          parent: findClone(scope.runner.scope.anyway),
        })
        break
    }
  })

  return {
    syncComplete() {
      fxCount.syncComplete = true
      completeInitPhase()
    },
    req: defer.req,
    scope: {
      find: findClone,
      getDomain: () => parentUnit,
      graphite: createNode({
        node: [],
        meta: {unit: 'domain'},
        family: {
          type: 'domain',
          links: clones,
        },
      }),
    },
  }

  function findClone(unit) {
    unit = getGraph(unit)
    const index = list.indexOf(unit)
    if (index === -1) throw Error('not found')
    return clones[index]
  }

  function forEachRelatedNode({next, family}, cb) {
    next.forEach(cb)
    family.owners.forEach(cb)
    family.links.forEach(cb)
  }
  function wrapStore(node) {
    return {
      kind: 'store',
      getState: () => node.reg[node.scope.state.id].current,
      updates: {
        watch: bind(watchUnit, node),
      },
      graphite: node,
      family: node.family,
    }
  }
}
