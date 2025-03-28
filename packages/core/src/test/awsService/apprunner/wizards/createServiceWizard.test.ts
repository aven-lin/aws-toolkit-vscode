/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import { createWizardTester, WizardTester } from '../../../shared/wizards/wizardTestUtils'
import { CreateAppRunnerServiceWizard } from '../../../../awsService/apprunner/wizards/apprunnerCreateServiceWizard'
import { stub } from '../../../utilities/stubber'
import { IamClient } from '../../../../shared/clients/iam'
import { DefaultEcrClient } from '../../../../shared/clients/ecrClient'
import { AppRunnerClient, CreateServiceRequest } from '../../../../shared/clients/apprunner'

describe('CreateServiceWizard', function () {
    let tester: WizardTester<CreateServiceRequest>

    beforeEach(async function () {
        const regionCode = 'us-east-1'
        const wizard = new CreateAppRunnerServiceWizard(
            regionCode,
            {},
            {},
            {
                iam: stub(IamClient, { regionCode }),
                ecr: stub(DefaultEcrClient, { regionCode }),
                apprunner: stub(AppRunnerClient, { regionCode }),
            }
        )

        tester = await createWizardTester(wizard)
    })

    describe('CreateAppRunnerServiceWizard', function () {
        it('prompts for source first', function () {
            tester.SourceConfiguration.assertShowFirst()
        })

        it('prompts for role ARN if choosing private ECR', function () {
            tester.SourceConfiguration.applyInput({ ImageRepository: { ImageRepositoryType: 'ECR' } as any })
            tester.SourceConfiguration.AuthenticationConfiguration.AccessRoleArn.assertShow()
        })

        it('prompts for connection ARN if choosing Repository', function () {
            tester.SourceConfiguration.applyInput({ CodeRepository: {} as any })
            tester.SourceConfiguration.AuthenticationConfiguration.ConnectionArn.assertShow()
        })

        it('prompts for name before instance', function () {
            tester.ServiceName.assertShowSecond() // TODO: write a 'assertShowBefore' that accepts another form element as input
            tester.InstanceConfiguration.assertShowThird()
        })

        it('sets auto-deployment to "off" by default', function () {
            tester.SourceConfiguration.AutoDeploymentsEnabled.assertValue(false)
        })

        it('prompts for ECR or GitHub repository', function () {
            tester.SourceConfiguration.assertShow()
            tester.SourceConfiguration.CodeRepository.assertDoesNotShowAny()
            tester.SourceConfiguration.ImageRepository.assertDoesNotShowAny()

            tester.SourceConfiguration.applyInput({ CodeRepository: {} as any })
            tester.SourceConfiguration.CodeRepository.assertShowAny()

            tester.SourceConfiguration.applyInput({ ImageRepository: {} as any })
            tester.SourceConfiguration.ImageRepository.assertShowAny()
        })
    })
})
