const { Selection } = require('prosemirror-state')
const { Node } = require('prosemirror-model')
const { Step } = require('prosemirror-transform')
const { collab, sendableSteps, receiveTransaction } = require('prosemirror-collab')
const { compressStepsLossy, compressStateJSON, uncompressStateJSON, compressSelectionJSON, uncompressSelectionJSON, compressStepJSON, uncompressStepJSON } = require('prosemirror-compress')
const { off, query, runTransaction, startAt, orderByKey, onChildAdded, onChildChanged, onChildRemoved, get, onDisconnect, remove, set, child, push } = require("firebase/database")
const TIMESTAMP = { '.sv': 'timestamp' }

module.exports.FirebaseEditor = class FirebaseEditor {
  constructor({ firebaseRef, stateConfig, clientID, view: constructView, progress = _ => _ }) {
    progress(0 / 2)
    const this_ = this
    const selfClientID = clientID || push(firebaseRef).key
    const checkpointRef = this.checkpointRef = child(firebaseRef, 'checkpoint')
    const changesRef = this.changesRef = child(firebaseRef, 'changes')
    const selectionsRef = this.selectionsRef = child(firebaseRef, 'selections')
    const selfSelectionRef = this.selfSelectionRef = child(selectionsRef, selfClientID)
    onDisconnect(selfSelectionRef).remove()
    const selections = this.selections = {}
    const selfChanges = {}
    let selection = undefined

    const constructEditor = get(checkpointRef).then(
      function (snapshot) {
        progress(1 / 2)
        let { d, k: latestKey = -1 } = snapshot.val() || {}
        latestKey = Number(latestKey)
        stateConfig.doc = d && Node.fromJSON(stateConfig.schema, uncompressStateJSON({ d }).doc)
        stateConfig.plugins = (stateConfig.plugins || []).concat(collab({ clientID: selfClientID }))

        function compressedStepJSONToStep(compressedStepJSON) {
          return Step.fromJSON(stateConfig.schema, uncompressStepJSON(compressedStepJSON)) }

        function updateCollab({ docChanged, mapping }, newState) {
          if (docChanged) {
            for (let clientID in selections) {
              selections[clientID] = selections[clientID].map(newState.doc, mapping)
            }
          }

          const sendable = sendableSteps(newState)
          if (sendable) {
            const { steps, clientID } = sendable
            runTransaction(child(changesRef, String(latestKey + 1)),
              function (existingBatchedSteps) {
                if (!existingBatchedSteps) {
                  selfChanges[latestKey + 1] = steps
                  return {
                    s: compressStepsLossy(steps).map(
                      function (step) {
                        return compressStepJSON(step.toJSON()) } ),
                    c: clientID,
                    t: TIMESTAMP,
                  }
                }
              },
              { applyLocally: false })
              .then(function ({ committed, snapshot }) {
                const key = snapshot.key
                if (committed && key % 100 === 0 && key > 0) {
                  const { d } = compressStateJSON(newState.toJSON())
                  set(checkpointRef, { d, k: key, t: TIMESTAMP })
                }
              })
              .catch(function (error) {
                console.error('updateCollab', error, sendable, key)
              })
          }

          const selectionChanged = !newState.selection.eq(selection)
          if (selectionChanged) {
            selection = newState.selection
            set(selfSelectionRef, compressSelectionJSON(selection.toJSON()))
          }
        }

        return get(query(changesRef, orderByKey(), startAt(String(latestKey + 1)))).then(
          function (snapshot) {
            progress(2 / 2)
            const view = this_.view = constructView({ stateConfig, updateCollab, selections })
            const editor = view.editor || view

            const changes = snapshot.val()
            if (changes) {
              const steps = []
              const stepClientIDs = []
              const placeholderClientId = '_oldClient' + Math.random()
              const keys = Object.keys(changes)
              latestKey = Math.max(...keys)
              for (let key of keys) {
                const compressedStepsJSON = changes[key].s
                steps.push(...compressedStepsJSON.map(compressedStepJSONToStep))
                stepClientIDs.push(...new Array(compressedStepsJSON.length).fill(placeholderClientId))
              }
              editor.dispatch(receiveTransaction(editor.state, steps, stepClientIDs))
            }

            function updateClientSelection(snapshot) {
              const clientID = snapshot.key
              if (clientID !== selfClientID) {
                const compressedSelection = snapshot.val()
                if (compressedSelection) {
                  try {
                    selections[clientID] = Selection.fromJSON(editor.state.doc, uncompressSelectionJSON(compressedSelection))
                  } catch (error) {
                    console.warn('updateClientSelection', error)
                  }
                } else {
                  delete selections[clientID]
                }
                editor.dispatch(editor.state.tr)
              }
            }

            onChildAdded(selectionsRef, updateClientSelection)
            onChildChanged(selectionsRef, updateClientSelection)
            onChildRemoved(selectionsRef, updateClientSelection)

            onChildAdded(query(changesRef, orderByKey(), startAt(String(latestKey + 1))),
              function (snapshot) {
                latestKey = Number(snapshot.key)
                const { s: compressedStepsJSON, c: clientID } = snapshot.val()
                const steps = (
                  clientID === selfClientID ?
                    selfChanges[latestKey]
                    :
                    compressedStepsJSON.map(compressedStepJSONToStep))
                const stepClientIDs = new Array(steps.length).fill(clientID)
                editor.dispatch(receiveTransaction(editor.state, steps, stepClientIDs))
                delete selfChanges[latestKey]
              } )


            return Object.assign({
              destroy: this_.destroy.bind(this_),
            }, this_)
          } )
      } )

    Object.defineProperties(this, {
      then: { value: constructEditor.then.bind(constructEditor) },
      catch: { value: constructEditor.catch.bind(constructEditor) },
    })
  }

  destroy() {
    this.catch(_=>_).then(() => {
      off(this.changesRef)
      off(this.selectionsRef)
      off(this.selfSelectionRef)
      remove(this.selfSelectionRef)
      this.view.destroy()
    })
  }
}
